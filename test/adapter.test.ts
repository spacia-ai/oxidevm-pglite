import { afterEach, describe, expect, it } from "vitest";
import definition from "../module.ts";
import { join } from "../src/bytes.ts";
import { fakeConnection, frame, replyOf } from "./support/connection.ts";
import { FakeVm } from "./support/fake-host.ts";
import { query, startup, terminate } from "./support/wire.ts";

const vms: FakeVm[] = [];
afterEach(() => { for (const vm of vms.splice(0)) vm.dispose(); });

function vm(options: ConstructorParameters<typeof FakeVm>[0] = {}): FakeVm {
  const created = new FakeVm(options);
  vms.push(created);
  return created;
}

const request = (sql: string, params: unknown[] = []): Uint8Array => frame(JSON.stringify({ sql, params }));

async function ask(hooks: Awaited<ReturnType<typeof definition.adapter>>, sql: string, params: unknown[] = []): Promise<unknown> {
  const connection = fakeConnection(request(sql, params));
  await hooks.protocols.sql(connection);
  return replyOf(connection);
}

describe("starting the adapter", () => {
  it("writes the guest files, starts the metadata helper, creates the database and reports itself", async () => {
    const machine = vm();
    const hooks = await definition.adapter(machine.host());

    for (const name of ["pg-metadata.py", "pg-writer.py", "oxidevm_pglite.py"]) expect(machine.exists(`/workspace/_oxidevm/${name}`), name).toBe(true);
    expect(machine.read("/workspace/_oxidevm/oxidevm_pglite.py")).toContain("oxidevm-sql/1");
    expect(machine.spawned).toEqual([{
      command: "/usr/bin/python3",
      args: ["-u", "/workspace/_oxidevm/pg-metadata.py", "/workspace/pgdata", "/workspace/_oxidevm/pgdata-migrating"],
      stdoutIs: "terminal",
    }]);
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

  it("serves a native PostgreSQL client through a writer helper that borrows the client's socket", async () => {
    const machine = vm();
    const hooks = await definition.adapter(machine.host());
    const connection = fakeConnection(join(startup(), query("SELECT 41 + 1 AS answer"), terminate()));
    await hooks.protocols.pg(connection);
    const writer = machine.spawned.find(item => item.args[1]?.endsWith("pg-writer.py") === true);
    expect(writer?.args[0]).toBe("-u");
    expect(writer?.args[2]).toMatch(/^\/workspace\/_oxidevm\/pgwire-[0-9a-f-]{36}\.out$/u);
    expect(writer?.stdoutIs).toBe(String(connection.fd));
    expect(machine.received(String(connection.fd)).map(item => item.type).join("")).toBe("RSSSSSSZTDCZ");
    expect(machine.exists("/workspace/_oxidevm")).toBe(true);
    expect(machine.waited).toHaveLength(1);
    await hooks.close?.();
    expect(machine.waited).toHaveLength(2);
    expect(machine.signals).toEqual([]);
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
    const info = await hooks.info?.();
    expect(info).toMatchObject({ dataDir: "/workspace/data/main", durability: "relaxed" });
    expect(machine.exists("/workspace/data/main/PG_VERSION")).toBe(true);
    await hooks.close?.();
  });
});

describe("a start that cannot succeed", () => {
  it("refuses a data directory outside the workspace before it starts anything", async () => {
    const machine = vm({ dataDir: "/etc/pgdata" });
    await expect(Promise.resolve().then(() => definition.adapter(machine.host()))).rejects.toThrow(/dataDir/u);
    expect(machine.spawned).toEqual([]);
    expect(machine.exists("/workspace/_oxidevm")).toBe(false);
  });

  it("stops the metadata helper when the database cannot be opened", async () => {
    const machine = vm({ legacyIndexedDb: "old-database" });
    await expect(definition.adapter(machine.host())).rejects.toThrow(/indexedDB/u);
    expect(machine.spawned).toHaveLength(1);
    expect(machine.waited).toHaveLength(1);
    expect(machine.exists("/workspace/pgdata")).toBe(false);
  });

  it("refuses a data directory that was not made by this module", async () => {
    const machine = vm();
    machine.harness.files.mkdir("/workspace/pgdata", 0o700);
    await expect(definition.adapter(machine.host())).rejects.toThrow("has no verified migration marker");
    expect(machine.waited).toHaveLength(1);
  });
});
