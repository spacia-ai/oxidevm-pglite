import type { UserspaceVM } from "@oxidevm/sdk";
import { spawnModule, stopModule } from "@oxidevm/sdk/wasm";
import { CLIENT_ENV, CLIENT_IMPORT, DEV_NULL_WRITES, DRIVER, JSON_HANGUP, JSON_POLL, NATIVE_CLEAN_HANGUP, NATIVE_HANGUP, PSQL_KILLED, exchangeOf, installClients, psql, psqlToDevNull, rawExchange, sqlRequest } from "./native";
import { pglite } from "./oxidevm.modules.generated";
import type { ScenarioResult, SuiteConfig } from "./protocol";
import { describeExit, expect, expectEqual, expectFailure, openVM, python, run, runScenarios, sha256, until } from "./util";
import type { Scenario } from "./util";

const WORKSPACE_ID = "pglite-core";
const SOCKET = "/workspace/_oxidevm/pglite.sock";

type Service = Awaited<ReturnType<typeof start>>;

function start(vm: UserspaceVM, options: { readonly durability?: "relaxed" | "strict" } = {}) {
  return spawnModule(vm, pglite, { workspaceId: WORKSPACE_ID, options });
}

const socketState = (vm: UserspaceVM): Promise<string> => python(vm, `import os, stat\ntry:\n    print('socket' if stat.S_ISSOCK(os.stat('${SOCKET}').st_mode) else 'other')\nexcept FileNotFoundError:\n    print('absent')`);
const portState = (vm: UserspaceVM): Promise<string> => python(vm, "import socket\ntry:\n    socket.create_connection(('127.0.0.1', 5432), 5).close()\n    print('open')\nexcept ConnectionRefusedError:\n    print('closed')");

/** What a failing scenario needs to know about the service: the end of its standard error and how it ended. */
interface ServiceWatch { text: string; exit: string }

/** Keeps the end of a service's standard error, which says why a connection handler failed, and how the service ended. */
function watchService(service: Service, watch: ServiceWatch): void {
  void service.exit.then(exit => { watch.exit = describeExit(exit); }, () => undefined);
  const decoder = new TextDecoder();
  void (async () => {
    const reader = service.stderr.getReader();
    for (;;) {
      const part = await reader.read();
      if (part.done) return;
      watch.text = (watch.text + decoder.decode(part.value, { stream: true })).slice(-3000);
    }
  })().catch(() => undefined);
}

/** The module in a real Userspace VM on the real engine, driven the way an application and its Linux programs drive it. */
export async function core(config: SuiteConfig): Promise<readonly ScenarioResult[]> {
  const vm = await openVM(config);
  let service: Service | undefined;
  const stderr: ServiceWatch = { text: "", exit: "still running" };
  let clientsInstalled = false;
  const ensureClients = async (): Promise<void> => {
    if (clientsInstalled) return;
    await installClients(vm, config);
    clientsInstalled = true;
  };
  const running = (): Service => {
    if (service === undefined) throw new Error("The module is not running: an earlier scenario failed to start it");
    return service;
  };
  const scenarios: readonly Scenario[] = [
    ["start: an invalid dataDir is refused by the adapter with its own message", async () => {
      const refused = await expectFailure(spawnModule(vm, pglite, { workspaceId: WORKSPACE_ID, options: { dataDir: "/tmp/pgdata" } }));
      expect(refused.code === "GUEST_CRASH" && refused.reason === "wasm-module-adapter" && refused.message.includes("The dataDir option must be an absolute path inside /workspace"), JSON.stringify(refused));
      const written = await python(vm, "import os\nprint(os.path.exists('/workspace/_oxidevm/oxidevm_pglite.py'))");
      return `${refused.reason}; guest files written by the runner before the adapter ran: ${written}`;
    }],
    ["start: the first start creates the database and reports itself in the ready line", async () => {
      const started = performance.now();
      service = await start(vm);
      watchService(service, stderr);
      const { info, endpoints } = service;
      expectEqual(info, { version: "18.6", backend: "pglite-wasm", dataDir: "/workspace/pgdata", durability: "strict" }, "info");
      expectEqual(endpoints, pglite.manifest.expose, "endpoints");
      const version = await python(vm, "import sys\nprint(sys.version.split()[0])");
      return `${((performance.now() - started) / 1000).toFixed(1)} s, python ${version}, pid ${String(service.pid)}`;
    }],
    ["guest files: the Python client is in the workspace with the pinned content, and no helper program exists", async () => {
      const pin = pglite.pins.artifacts["oxidevm_pglite.py"];
      expect(pin !== undefined, "oxidevm_pglite.py is not pinned");
      expectEqual(await sha256(await vm.workspace.readText("_oxidevm/oxidevm_pglite.py")), pin?.sha256, "oxidevm_pglite.py");
      const names = await python(vm, "import os\nprint(sorted(name for name in os.listdir('/workspace/_oxidevm') if name.endswith('.py')))");
      expectEqual(names, "['oxidevm_pglite.py']", "Python files of the module");
      return "oxidevm_pglite.py";
    }],
    ["JSON endpoint: the reply has the documented shape (raw socket, native python3)", async () => {
      const out = exchangeOf(await python(vm, rawExchange(sqlRequest("SELECT 42 AS n, $1::text AS label", '["x"]'))));
      expectEqual(out.reply, {
        ok: true,
        result: { rows: [{ n: 42, label: "x" }], fields: [{ name: "n", dataTypeID: 23 }, { name: "label", dataTypeID: 25 }], affectedRows: 0, command: "SELECT", rowCount: 1, pid: running().pid, backend: "pglite-wasm" },
      }, "reply");
      const failing = exchangeOf(await python(vm, rawExchange(sqlRequest("SELECT * FROM nowhere"))));
      expectEqual(failing.reply, { ok: false, error: 'relation "nowhere" does not exist' }, "error reply");
      return `reply of ${String(out.size)} bytes`;
    }],
    ["oxidevm_pglite.query from native python3: parameters, 64-bit integers as text, errors, COPY refused", async () => {
      const out = await python(vm, `${CLIENT_IMPORT}
pg.query("CREATE TABLE people(id integer PRIMARY KEY, name text, big bigint)")
pg.query("INSERT INTO people VALUES ($1, $2, $3)", [1, "Ada", "9223372036854775807"])
pg.query("INSERT INTO people VALUES ($1, $2, $3)", [2, None, 1])
result = pg.query("SELECT * FROM people ORDER BY id")
print(result["rows"])
print(result["backend"], result["command"])
try:
    pg.query("SELECT * FROM nowhere")
except pg.PGliteError as error:
    print("error:", error)
try:
    pg.query("COPY people FROM STDIN")
except pg.PGliteError as error:
    print("copy:", error)`);
      expectEqual(out.split("\n"), [
        "[{'id': 1, 'name': 'Ada', 'big': '9223372036854775807'}, {'id': 2, 'name': None, 'big': 1}]",
        "pglite-wasm SELECT",
        'error: relation "nowhere" does not exist',
        "copy: COPY is unavailable through this experimental SQL bridge",
      ], "client output");
      return "ok";
    }],
    ["JSON endpoint limits: 64 KiB request, 1 MiB reply, and silence for a client that hangs up first", async () => {
      const large = exchangeOf(await python(vm, rawExchange("struct.pack('!I', 65537)", { raw: true })));
      expectEqual(large.reply, { ok: false, error: "Database request exceeds 64 KiB" }, "oversized request");
      const big = exchangeOf(await python(vm, rawExchange(sqlRequest("SELECT repeat('x', 1048577) AS big"))));
      expectEqual(big.reply, { ok: false, error: "Database response exceeds 1 MiB. Use LIMIT or select fewer columns." }, "oversized reply");
      const hangup = await python(vm, "import socket\nfor part in (b'', b'\\x00\\x00', b'\\x00\\x00\\x00\\x10{\"sql\"'):\n    s = socket.socket(socket.AF_UNIX)\n    s.connect('/workspace/_oxidevm/pglite.sock')\n    s.sendall(part)\n    s.close()\nprint('hung up')");
      const still = await python(vm, `${CLIENT_IMPORT}print(pg.query("SELECT 1 AS one")["rows"])`);
      return `${hangup}; still serving: ${still}`;
    }],
    ["psql: native libpq reaches PostgreSQL over TCP 5432", async () => {
      await ensureClients();
      const out = await psql(vm, "SELECT version(); SELECT 42");
      expect(/wasm32/u.test(out) && /PostgreSQL 18\.6/u.test(out) && out.endsWith("42"), out);
      return out.split("\n")[0] ?? "";
    }],
    ["psql: a 30 MB value printed to /dev/null, and 30 MB write(2) and writev(2) there, are accepted whole", async () => {
      await ensureClients();
      const printed = await psqlToDevNull(vm, "SELECT repeat('x', 30000000)");
      expect(printed.status === 0, `psql with its output on /dev/null exited ${String(printed.status)}: ${printed.stderr.trim().slice(-500)}`);
      const counts = await python(vm, DEV_NULL_WRITES);
      expectEqual(counts, "30000000 30000000", "what write(2) and writev(2) of 30 MB to /dev/null returned");
      return `psql exited 0; write and writev returned ${counts}`;
    }],
    ["psycopg + session isolation: extended protocol, binary, COPY, large results, idle connection, vanished client", async () => {
      await ensureClients();
      await vm.workspace.writeText("_oxidevm/driver-test.py", DRIVER);
      await vm.workspace.remove("_oxidevm/pg-idle-ready").catch(() => undefined);
      const driver = run(vm, { command: "/usr/bin/python3", args: ["/workspace/_oxidevm/driver-test.py"], env: CLIENT_ENV, signal: AbortSignal.timeout(600_000) });
      await until(async () => (await vm.workspace.readText("_oxidevm/pg-idle-ready").catch(() => "")) === "ready", "the driver to reach its idle connection", 300);
      const busy = exchangeOf(await python(vm, rawExchange(sqlRequest("SELECT 42"))));
      expectEqual(busy.reply, { ok: false, error: "A native PostgreSQL connection owns the database. Close it before using oxidevm.query()." }, "isolation reply");
      const finished = await driver;
      expect(finished.status === 0 && finished.stdout.includes("PSYCOPG_EXTENDED_BINARY_COPY_LARGE_RECOVERY_OK"), `driver: ${String(finished.status)} ${finished.stdout.slice(-500)} ${finished.stderr.slice(-1500)}`);
      const afterwards = await python(vm, `${CLIENT_IMPORT}print(pg.query("SELECT count(*)::int AS n FROM wire_data")["rows"])`);
      expectEqual(afterwards, "[{'n': 3}]", "rows after the session");
      return "psycopg ok, JSON endpoint refused while the native connection was open";
    }],
    ["hang-up: a client that vanishes in the middle of a large result ends its own session only, while another client keeps getting answers", async () => {
      await ensureClients();
      const pid = running().pid;
      stderr.text = "";
      const gone = (): number => stderr.text.split("PostgreSQL client stopped receiving data").length - 1;
      const noticed = async (count: number, what: string): Promise<void> => {
        await until(() => Promise.resolve(gone() >= count || stderr.exit !== "still running"), what, 120);
        expect(stderr.exit === "still running", `the module ended instead of failing that one connection: ${stderr.exit}`);
      };
      const polling = run(vm, { command: "/usr/bin/python3", args: ["-c", JSON_POLL], signal: AbortSignal.timeout(300_000) });
      try {
        const closed = await python(vm, NATIVE_CLEAN_HANGUP);
        await noticed(1, "the module to notice a client that closed cleanly");
        const vanished = await python(vm, NATIVE_HANGUP);
        await noticed(2, "the module to notice a client that reset the connection");
        const killed = await python(vm, PSQL_KILLED, CLIENT_ENV);
        expect(killed.includes("still receiving"), `psql was not in the middle of its result: ${killed}`);
        await noticed(3, "the module to notice that psql was killed");
        const jsonHangups = await python(vm, JSON_HANGUP);
        const poll = await polling;
        expect(poll.status === 0, `poller: ${String(poll.status)} ${poll.stderr.slice(-500)}`);
        const outcomes: unknown = JSON.parse(poll.stdout.trim());
        expect(Array.isArray(outcomes), "the poller printed no list");
        const answers = Array.from<unknown>(Array.isArray(outcomes) ? outcomes : []).map(String);
        expect(!answers.some(outcome => outcome.startsWith("connection-failed")), `a JSON client was refused: ${answers.join(" ")}`);
        expect(answers.filter(outcome => outcome === "ok").length >= 3 && answers.at(-1) === "ok", `the module did not keep answering: ${answers.join(" ")}`);
        const after = await python(vm, `${CLIENT_IMPORT}print(pg.query("SELECT 1 AS alive")["pid"])`);
        expectEqual(after, String(pid), "pid of the service after the hang-ups");
        expect(await psql(vm, "SELECT 11") === "11", "psql after the hang-ups");
        expect(stderr.text.includes("connection handler failed"), "the hang-ups left no trace in the module's log");
        return `${closed}; ${vanished}; ${killed}; ${jsonHangups}; JSON poller: ${String(answers.length)} replies (${String(answers.filter(outcome => outcome === "ok").length)} ok, ${String(answers.filter(outcome => outcome === "busy").length)} busy); same pid ${after}`;
      } finally {
        await polling.catch(() => undefined);
      }
    }],
    ["four clients at most: a fifth connection is closed at once and the service keeps serving", async () => {
      await ensureClients();
      const out = await python(vm, [
        "import json, os, socket, struct",
        "def state(connection):",
        "    connection.settimeout(1)",
        "    try:",
        "        return 'closed' if connection.recv(1) == b'' else 'data'",
        "    except TimeoutError:",
        "        return 'open'",
        "    except OSError as error:",
        "        return 'error ' + str(error)",
        "held = [socket.create_connection(('127.0.0.1', 5432)) for _ in range(4)]",
        "extra = socket.create_connection(('127.0.0.1', 5432))",
        "extra.settimeout(60)",
        "try:",
        "    closed = extra.recv(1) == b''",
        "except TimeoutError:",
        "    report = {'held': [state(connection) for connection in held]}",
        "    later = socket.create_connection(('127.0.0.1', 5432))",
        "    report['sixth'] = state(later)",
        "    try:",
        "        probe = socket.socket(socket.AF_UNIX)",
        "        probe.settimeout(20)",
        "        probe.connect('/workspace/_oxidevm/pglite.sock')",
        "        body = json.dumps({'sql': 'SELECT 1', 'params': []}).encode()",
        "        probe.sendall(struct.pack('!I', len(body)) + body)",
        "        report['json'] = probe.recv(64).decode(errors='replace')",
        "    except OSError as error:",
        "        report['json'] = 'error ' + str(error)",
        "    names = []",
        "    for entry in sorted(os.listdir('/proc')):",
        "        if entry.isdigit():",
        "            try:",
        "                names.append(entry + ':' + open('/proc/' + entry + '/cmdline').read().replace(chr(0), ' ').strip()[:70])",
        "            except OSError:",
        "                pass",
        "    report['processes'] = names",
        "    print('extra-served (not closed within 60 s) ' + json.dumps(report))",
        "    raise SystemExit(0)",
        "print('extra-closed' if closed else 'extra-served')",
        "for c in held:",
        "    c.close()",
      ].join("\n"));
      expectEqual(out, "extra-closed", "fifth connection");
      await until(async () => (await psql(vm, "SELECT 7").catch(() => "")) === "7", "the service to serve again after the held connections ended", 120);
      return out;
    }],
    ["busy: a second start in the same workspace fails while the first runs", async () => {
      const refused = await expectFailure(start(vm));
      expect(refused.code === "QUOTA_EXCEEDED" && refused.reason === "wasm-module-busy", JSON.stringify(refused));
      return refused.message;
    }],
    ["crash safety: a killed service leaves a stale socket, the next start replaces it and keeps committed data", async () => {
      await psql(vm, "INSERT INTO wire_data VALUES (4, 'before the kill')");
      await running().kill("SIGKILL");
      const exit = await running().exit;
      const stale = await socketState(vm);
      service = await start(vm);
      const count = await psql(vm, "SELECT count(*) FROM wire_data");
      expectEqual(count, "4", "rows after the restart");
      return `${describeExit(exit)}, socket ${stale}, ${count} rows`;
    }],
    ["stop: closing standard input stops the service, removes the socket and closes the port", async () => {
      const exit = await stopModule(running());
      service = undefined;
      expect(exit.kind === "exited" && exit.code === 0, describeExit(exit));
      const state = `socket ${await socketState(vm)}, port ${await portState(vm)}`;
      expectEqual(state, "socket absent, port closed", "after stop");
      return `${describeExit(exit)}, ${state}`;
    }],
    ["restart: the data is there after a clean stop", async () => {
      service = await start(vm);
      const rows = await python(vm, `${CLIENT_IMPORT}print(pg.query("SELECT n FROM wire_data ORDER BY n")["rows"])`);
      expectEqual(rows, "[{'n': 1}, {'n': 2}, {'n': 3}, {'n': 4}]", "rows after the restart");
      return rows;
    }],
    ["durability relaxed: starts, reports it, and answers", async () => {
      await stopModule(running());
      service = await start(vm, { durability: "relaxed" });
      expectEqual(running().info["durability"], "relaxed", "info.durability");
      await python(vm, `${CLIENT_IMPORT}pg.query("INSERT INTO wire_data VALUES (5, 'relaxed')")`);
      const count = await psql(vm, "SELECT count(*) FROM wire_data");
      expectEqual(count, "5", "rows");
      return "5 rows";
    }],
  ];
  try {
    return await runScenarios(scenarios, config.only, () => `the module is ${stderr.exit}; its stderr: ${JSON.stringify(stderr.text.slice(-1500))}`);
  } finally {
    if (service !== undefined) await stopModule(service).catch(() => undefined);
    await vm.dispose();
  }
}
