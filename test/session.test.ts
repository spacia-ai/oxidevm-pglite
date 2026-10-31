import { kit } from "@oxidevm/sdk/wasm";
import { describe, expect, it } from "vitest";
import { SESSION_BUSY_MESSAGE, SESSION_WAIT_MS, SESSION_WAIT_EXPIRED_MESSAGE, withStatementSession } from "../src/session.ts";

describe("the shared gate (ported from the sample's SessionGate test)", () => {
  it("serves one session at a time in arrival order, drops cancelled waits, and ignores a second release", async () => {
    const gate = kit.gate(), signal = new AbortController().signal;
    const first = await gate.acquire(signal), cancel = new AbortController();
    const cancelled = gate.acquire(cancel.signal);
    cancel.abort(Error("Disconnected before SQL execution"));
    await expect(cancelled).rejects.toThrow(/Disconnected/u);
    const next = gate.acquire(signal), order: string[] = [];
    const later = gate.acquire(signal).then(release => { order.push("later"); release(); });
    first();
    const release = await next;
    order.push("next");
    release();
    release();
    await later;
    expect(order).toEqual(["next", "later"]);
    const final = await gate.acquire(signal);
    final();
  });
});

/** A clock the test moves by hand, with wait signals it aborts by hand. */
function clock(start = 1000): { now: () => number; advance(ms: number): void; timeout(ms: number): AbortSignal; readonly waits: number[]; expire(): void } {
  let current = start;
  const waits: number[] = [], controllers: AbortController[] = [];
  return {
    now: () => current,
    advance: ms => { current += ms; },
    timeout: ms => { waits.push(ms); const controller = new AbortController(); controllers.push(controller); return controller.signal; },
    waits,
    expire: () => { for (const controller of controllers) controller.abort(new DOMException("timed out", "TimeoutError")); },
  };
}

describe("withStatementSession", () => {
  it("runs at once when nobody holds the database, waiting at most 250 ms, and releases afterwards", async () => {
    const gate = kit.gate(), time = clock();
    expect(SESSION_WAIT_MS).toBe(250);
    expect(await withStatementSession(gate, new AbortController().signal, () => Promise.resolve("done"), time)).toBe("done");
    expect(time.waits).toEqual([250]);
    const again = await gate.acquire(new AbortController().signal);
    again();
  });

  it("reports that a native connection owns the database when the wait runs out, without running", async () => {
    const gate = kit.gate(), time = clock();
    const holder = await gate.acquire(new AbortController().signal);
    let ran = false;
    const waiting = withStatementSession(gate, new AbortController().signal, () => { ran = true; return Promise.resolve(); }, time);
    time.expire();
    await expect(waiting).rejects.toThrow(SESSION_BUSY_MESSAGE);
    expect(SESSION_BUSY_MESSAGE).toBe("A native PostgreSQL connection owns the database. Close it before using oxidevm.query().");
    expect(ran).toBe(false);
    holder();
    const free = await gate.acquire(new AbortController().signal);
    free();
  });

  it("runs once the holder lets go within the wait", async () => {
    const gate = kit.gate(), time = clock();
    const holder = await gate.acquire(new AbortController().signal);
    const waiting = withStatementSession(gate, new AbortController().signal, () => Promise.resolve(42), time);
    holder();
    expect(await waiting).toBe(42);
  });

  it("serves waiting statements in arrival order", async () => {
    const gate = kit.gate(), time = clock(), order: number[] = [];
    const holder = await gate.acquire(new AbortController().signal);
    const runs = [1, 2, 3].map(index => withStatementSession(gate, new AbortController().signal, () => { order.push(index); return Promise.resolve(); }, time));
    holder();
    await Promise.all(runs);
    expect(order).toEqual([1, 2, 3]);
  });

  it("reports the same message when the request itself was cancelled while waiting", async () => {
    const gate = kit.gate(), time = clock(), request = new AbortController();
    const holder = await gate.acquire(new AbortController().signal);
    const waiting = withStatementSession(gate, request.signal, () => Promise.resolve(), time);
    request.abort(new Error("shutting down"));
    await expect(waiting).rejects.toThrow(SESSION_BUSY_MESSAGE);
    holder();
  });

  it("does not run a statement whose wait ended after its deadline, and lets the next one in", async () => {
    const gate = kit.gate(), time = clock();
    let ran = false;
    const slow = (): Promise<void> => { time.advance(251); return Promise.resolve(); };
    const holder = await gate.acquire(new AbortController().signal);
    const waiting = withStatementSession(gate, new AbortController().signal, () => { ran = true; return Promise.resolve(); }, time);
    await slow();
    holder();
    await expect(waiting).rejects.toThrow(SESSION_WAIT_EXPIRED_MESSAGE);
    expect(SESSION_WAIT_EXPIRED_MESSAGE).toBe("Database session wait expired before SQL execution");
    expect(ran).toBe(false);
    const free = await gate.acquire(new AbortController().signal);
    free();
  });

  it("allows a statement that waited exactly the limit", async () => {
    const gate = kit.gate(), time = clock();
    const holder = await gate.acquire(new AbortController().signal);
    const waiting = withStatementSession(gate, new AbortController().signal, () => Promise.resolve("ok"), time);
    time.advance(250);
    holder();
    expect(await waiting).toBe("ok");
  });

  it("does not run a statement whose request ended before it started, and releases the database", async () => {
    const gate = kit.gate(), time = clock(), request = new AbortController();
    let ran = false;
    const holder = await gate.acquire(new AbortController().signal);
    const waiting = withStatementSession(gate, request.signal, () => { ran = true; return Promise.resolve(); }, time);
    holder();
    request.abort(new Error("deadline"));
    await expect(waiting).rejects.toThrow();
    expect(ran).toBe(false);
    const free = await gate.acquire(new AbortController().signal);
    free();
  });

  it("releases the database when the statement fails", async () => {
    const gate = kit.gate(), time = clock();
    await expect(withStatementSession(gate, new AbortController().signal, () => Promise.reject(new Error("syntax error")), time)).rejects.toThrow("syntax error");
    const free = await gate.acquire(new AbortController().signal);
    free();
  });
});
