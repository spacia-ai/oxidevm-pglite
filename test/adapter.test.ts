import { afterEach, describe, expect, it } from "vitest";
import definition from "../module.ts";
import { concat, join } from "../src/bytes.ts";
import { fakeConnection, frame, replyOf } from "./support/connection.ts";
import type { FakeConnection } from "./support/connection.ts";
import { FakeVm } from "./support/fake-host.ts";
import { backendMessages, cstring, dataRow, int16, message, query, startup, terminate } from "./support/wire.ts";

const vms: FakeVm[] = [];
afterEach(() => { for (const vm of vms.splice(0)) vm.dispose(); });

function vm(options: ConstructorParameters<typeof FakeVm>[0] = {}): FakeVm {
  const created = new FakeVm(options);
  vms.push(created);
  return created;
}

type Hooks = Awaited<ReturnType<typeof definition.adapter>>;

const request = (sql: string, params: unknown[] = []): Uint8Array => frame(JSON.stringify({ sql, params }));

async function ask(hooks: Hooks, sql: string, params: unknown[] = []): Promise<unknown> {
  const connection = fakeConnection(request(sql, params));
  await hooks.protocols.sql(connection);
  return replyOf(connection);
}

/** A native client: its descriptor is a socket of the fake VM, and its COPY data is read from the connection. */
function client(machine: FakeVm, input: Uint8Array): FakeConnection {
  const connection = fakeConnection(input);
  machine.socket(connection.fd, count => connection.readSync(count));
  return connection;
}

/** Everything the module sent the client: the connection's writes and the synchronous writes to its socket, in order of the write calls. */
const sent = (machine: FakeVm, connection: FakeConnection) => backendMessages(concat([...machine.socketWrites.map(write => write.bytes), ...connection.written]));

describe("starting the adapter", () => {
  it("writes the Python client, creates the database and reports itself", async () => {
    const machine = vm();
    const hooks = await definition.adapter(machine.host());

    expect(machine.exists("/workspace/_oxidevm/oxidevm_pglite.py")).toBe(true);
    expect(machine.read("/workspace/_oxidevm/oxidevm_pglite.py")).toContain("oxidevm-sql/1");
    expect(machine.read("/workspace/pgdata/PG_VERSION").trim()).toBe("18");
    expect(JSON.parse(machine.read("/workspace/pgdata/.oxidevm-storage.json"))).toMatchObject({ version: 1, source: "new", backup: null });
    expect(await hooks.info?.()).toEqual({ version: "18.6", backend: "pglite-wasm", dataDir: "/workspace/pgdata", durability: "strict" });
    expect(Object.keys(hooks.protocols).sort()).toEqual(["pg", "sql"]);
    await hooks.close?.();
  });

  it("serves SQL on the JSON endpoint with the process id of the service", async () => {
    const machine = vm();
    const hooks = await definition.adapter(machine.host());
    await ask(hooks, "CREATE TABLE people(id integer, name text)");
    await ask(hooks, "INSERT INTO people VALUES ($1, $2)", [1, "Ada"]);
    const reply = await ask(hooks, "SELECT * FROM people");
    expect(reply).toMatchObject({ ok: true, result: { rows: [{ id: 1, name: "Ada" }], pid: 4321, backend: "pglite-wasm" } });
    await hooks.close?.();
  });

  it("answers a native PostgreSQL client with the connection's own write", async () => {
    const machine = vm();
    const hooks = await definition.adapter(machine.host());
    const connection = client(machine, join(startup(), query("SELECT 41 + 1 AS answer"), terminate()));
    await hooks.protocols.pg(connection);
    const messages = sent(machine, connection);
    expect(messages.map(item => item.type).join("")).toBe("RSSSSSSZTDCZ");
    expect(messages.filter(item => item.type === "D").map(item => dataRow(item.body))).toEqual([["42"]]);
    expect(connection.written).toHaveLength(2);
    expect(machine.socketWrites).toEqual([]);
    await hooks.close?.();
  });

  it("takes COPY data from the client's socket and sends the handshake synchronously, without raising SIGPIPE", async () => {
    const machine = vm();
    const hooks = await definition.adapter(machine.host());
    await ask(hooks, "CREATE TABLE copied(n integer, label text)");
    const copyData = message("d", new TextEncoder().encode("1\tone\n2\ttwo\n"));
    const connection = client(machine, join(startup(), query("COPY copied FROM STDIN"), copyData, message("c"), terminate()));
    await hooks.protocols.pg(connection);
    expect(machine.socketWrites).toHaveLength(1);
    expect(machine.socketWrites[0]).toMatchObject({ fd: connection.fd, options: { noSignal: true } });
    expect(backendMessages(machine.socketWrites[0]?.bytes ?? new Uint8Array(0)).map(item => item.type)).toEqual(["G"]);
    expect(sent(machine, connection).map(item => item.type).join("")).toBe("GRSSSSSSZCZ");
    expect(await ask(hooks, "SELECT n, label FROM copied ORDER BY n")).toMatchObject({ result: { rows: [{ n: 1, label: "one" }, { n: 2, label: "two" }] } });
    await hooks.close?.();
  });

  it("keeps the database for the next start, which opens it instead of creating it", async () => {
    const machine = vm();
    const first = await definition.adapter(machine.host());
    await ask(first, "CREATE TABLE kept(n integer)");
    await ask(first, "INSERT INTO kept VALUES (7)");
    await first.close?.();
    machine.logs.length = 0;
    const second = await definition.adapter(machine.host());
    expect(await ask(second, "SELECT n FROM kept")).toMatchObject({ ok: true, result: { rows: [{ n: 7 }] } });
    expect(machine.logs.join("\n")).not.toContain("created a new PostgreSQL database");
    await second.close?.();
  });

  it("reports the options it was given", async () => {
    const machine = vm({ dataDir: "/workspace/data/main", durability: "relaxed" });
    const hooks = await definition.adapter(machine.host());
    expect(await hooks.info?.()).toMatchObject({ dataDir: "/workspace/data/main", durability: "relaxed" });
    expect(machine.exists("/workspace/data/main/PG_VERSION")).toBe(true);
    await hooks.close?.();
  });
});

describe("starting nothing but itself", () => {
  it("never reaches for process.spawn, wait or signal: a whole life of the service only asks for the process id", async () => {
    const machine = vm();
    const hooks = await definition.adapter(machine.host());
    await ask(hooks, "CREATE TABLE life(n integer)");
    await hooks.protocols.pg(client(machine, join(startup(), query("INSERT INTO life VALUES (1)"), terminate())));
    await hooks.protocols.pg(client(machine, join(startup(), query("SELECT 1"), terminate())));
    await hooks.close?.();
    expect([...new Set(machine.processTouched)]).toEqual(["info"]);
  });

  it("is checked by a process that fails on the first forbidden member", () => {
    const machine = vm();
    const { process } = machine.host();
    const member = (name: string): unknown => Reflect.get(process, name);
    expect(() => member("spawn")).toThrow("reached for process.spawn");
    expect(() => member("wait")).toThrow("reached for process.wait");
    expect(() => member("signal")).toThrow("reached for process.signal");
    expect(member("info")).toBeTypeOf("function");
  });

  it("asks the host for exactly the capabilities the manifest grants", () => {
    expect([...definition.manifest.requires.host].sort()).toEqual(["files.sync", "process.info"]);
    expect(Object.keys(vm().host()).sort()).toEqual(["artifacts", "fail", "fs", "kit", "log", "options", "process", "signal", "stdio"]);
  });
});

describe("a start that cannot succeed", () => {
  it("refuses a data directory outside the workspace before it starts anything", async () => {
    const machine = vm({ dataDir: "/etc/pgdata" });
    await expect(Promise.resolve().then(() => definition.adapter(machine.host()))).rejects.toThrow(/dataDir/u);
    expect(machine.processTouched).toEqual([]);
    expect(machine.exists("/workspace/_oxidevm")).toBe(false);
  });

  it("leaves no data directory when the legacy database cannot be read", async () => {
    const machine = vm({ legacyIndexedDb: "old-database" });
    await expect(definition.adapter(machine.host())).rejects.toThrow(/indexedDB/u);
    expect(machine.exists("/workspace/pgdata")).toBe(false);
  });

  it("refuses a data directory that was not made by this module", async () => {
    const machine = vm();
    machine.harness.files.mkdir("/workspace/pgdata", 0o700);
    await expect(definition.adapter(machine.host())).rejects.toThrow("has no verified migration marker");
  });
});

describe("the helpers of the tests", () => {
  it("round-trip a COPY message", () => {
    expect(join(message("d", cstring("x")), int16(1)).length).toBe(9);
  });
});
