import { describe, expect, it } from "vitest";
import { within } from "../src/timing.ts";

describe("within", () => {
  it("resolves with the promise's value and stops listening to the signal", async () => {
    const controller = new AbortController();
    expect(await within(Promise.resolve(7), controller.signal)).toBe(7);
    controller.abort(new Error("late"));
  });

  it("rejects with the promise's own failure", async () => {
    await expect(within(Promise.reject(new Error("boom")), new AbortController().signal)).rejects.toThrow("boom");
  });

  it("rejects with the signal's reason as soon as the signal aborts, leaving the promise to finish alone", async () => {
    const controller = new AbortController(), pending = Promise.withResolvers<number>();
    const waiting = within(pending.promise, controller.signal);
    controller.abort(new Error("stop"));
    await expect(waiting).rejects.toThrow("stop");
    pending.reject(new Error("settles later, unobserved"));
    await new Promise(resolve => { setTimeout(resolve, 0); });
  });

  it("rejects at once for a signal that is already aborted", async () => {
    await expect(within(new Promise<number>(() => undefined), AbortSignal.abort(new Error("already")))).rejects.toThrow("already");
  });
});
