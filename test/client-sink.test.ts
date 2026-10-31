import { LinuxError } from "@oxidevm/sdk/js-process";
import { describe, expect, it } from "vitest";
import { CLIENT_GONE, STREAM_THRESHOLD, createClientSink } from "../src/client-sink.ts";
import type { ClientSinkPorts } from "../src/client-sink.ts";
import { descriptor } from "./support/node-files.ts";

interface Recorded {
  readonly ports: ClientSinkPorts;
  /** The async writes through `connection.write`, and the synchronous ones through `fs.writeAll`, as text. */
  readonly asynchronous: string[];
  readonly synchronous: { readonly fd: number; readonly text: string; readonly options: unknown }[];
}

const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
const encode = (value: string): Uint8Array => new TextEncoder().encode(value);
const live = new AbortController().signal;

function record(options: { readonly threshold?: number; readonly asyncFails?: Error; readonly syncFails?: Error; readonly asyncPending?: boolean } = {}): Recorded {
  const asynchronous: string[] = [], synchronous: Recorded["synchronous"][number][] = [];
  const ports: ClientSinkPorts = {
    connection: {
      fd: descriptor(33),
      write: bytes => {
        asynchronous.push(text(bytes));
        if (options.asyncPending === true) return new Promise<void>(() => undefined);
        return options.asyncFails === undefined ? Promise.resolve() : Promise.reject(options.asyncFails);
      },
    },
    fs: {
      writeAll: (fd, bytes, writeOptions) => {
        if (options.syncFails !== undefined) throw options.syncFails;
        synchronous.push({ fd, text: text(bytes), options: writeOptions });
      },
    },
    ...(options.threshold === undefined ? {} : { threshold: options.threshold }),
  };
  return { ports, asynchronous, synchronous };
}

describe("createClientSink", () => {
  it("collects a response and sends it in one write of the connection when the statement is done", async () => {
    const { ports, asynchronous, synchronous } = record();
    const sink = createClientSink(ports);
    sink.reset();
    sink.write(encode("first "));
    sink.write(encode("second"));
    expect(asynchronous).toEqual([]);
    await sink.flush(live);
    expect(asynchronous).toEqual(["first second"]);
    expect(synchronous).toEqual([]);
  });

  it("sends nothing for a response that is empty, and starts a new one after a flush", async () => {
    const { ports, asynchronous } = record();
    const sink = createClientSink(ports);
    await sink.flush(live);
    sink.write(encode("a"));
    await sink.flush(live);
    await sink.flush(live);
    sink.write(encode("b"));
    await sink.flush(live);
    expect(asynchronous).toEqual(["a", "b"]);
  });

  it("copies what PostgreSQL hands over, because PostgreSQL reuses that memory", async () => {
    const { ports, asynchronous } = record();
    const sink = createClientSink(ports);
    const reused = encode("original");
    sink.write(reused);
    reused.fill(0x58);
    await sink.flush(live);
    expect(asynchronous).toEqual(["original"]);
  });

  it("drops what was collected and not sent when a new response starts", async () => {
    const { ports, asynchronous } = record();
    const sink = createClientSink(ports);
    sink.write(encode("abandoned"));
    sink.reset();
    sink.write(encode("kept"));
    await sink.flush(live);
    expect(asynchronous).toEqual(["kept"]);
  });

  it("sends a response that grows past the threshold at once, synchronously and with noSignal, and the rest when done", async () => {
    const { ports, asynchronous, synchronous } = record({ threshold: 10 });
    const sink = createClientSink(ports);
    sink.write(encode("1234"));
    sink.write(encode("5678"));
    expect(synchronous).toEqual([]);
    sink.write(encode("9012"));
    expect(synchronous).toEqual([{ fd: 33, text: "123456789012", options: { noSignal: true } }]);
    sink.write(encode("tail"));
    await sink.flush(live);
    expect(synchronous).toHaveLength(1);
    expect(asynchronous).toEqual(["tail"]);
  });

  it("keeps a response of exactly the threshold in memory only when it is below it", () => {
    const { ports, synchronous } = record({ threshold: 10 });
    const sink = createClientSink(ports);
    sink.write(encode("123456789"));
    expect(synchronous).toEqual([]);
    sink.write(encode("0"));
    expect(synchronous).toHaveLength(1);
    expect(STREAM_THRESHOLD).toBe(1024 ** 2);
  });

  it("sends what is collected synchronously, with noSignal, when PostgreSQL waits for COPY data", () => {
    const { ports, asynchronous, synchronous } = record();
    const sink = createClientSink(ports);
    sink.flushSync();
    expect(synchronous).toEqual([]);
    sink.write(encode("G"));
    sink.flushSync();
    expect(synchronous).toEqual([{ fd: 33, text: "G", options: { noSignal: true } }]);
    expect(asynchronous).toEqual([]);
  });

  it("joins hundreds of thousands of small pieces", async () => {
    const { ports, asynchronous } = record({ threshold: 10 ** 9 });
    const sink = createClientSink(ports);
    for (let index = 0; index < 300_000; index += 1) sink.write(Uint8Array.of(120));
    await sink.flush(live);
    expect(asynchronous[0]?.length).toBe(300_000);
  });

  it("fails the session, not the module, when the client has hung up", async () => {
    const hungUp = new LinuxError(32);
    const async = record({ asyncFails: hungUp });
    const sink = createClientSink(async.ports);
    sink.write(encode("x"));
    await expect(sink.flush(live)).rejects.toThrow(CLIENT_GONE);
    sink.write(encode("y"));
    await expect(sink.flush(live)).rejects.toMatchObject({ message: CLIENT_GONE, cause: hungUp });

    const sync = record({ syncFails: hungUp });
    const other = createClientSink(sync.ports);
    other.write(encode("x"));
    expect(() => { other.flushSync(); }).toThrow(CLIENT_GONE);
    const streaming = createClientSink({ ...sync.ports, threshold: 1 });
    expect(() => { streaming.write(encode("xy")); }).toThrow(CLIENT_GONE);
  });

  it("gives up with the signal's reason when the write cannot complete in time, and keeps the reason as it is", async () => {
    const { ports } = record({ asyncPending: true });
    const sink = createClientSink(ports);
    const idle = new AbortController();
    sink.write(encode("x"));
    const sending = sink.flush(idle.signal);
    idle.abort(new Error("idle for too long"));
    await expect(sending).rejects.toThrow("idle for too long");
  });

  it("passes the signal's reason on when the connection itself fails because the module is stopping", async () => {
    const stopping = new Error("The module is stopping");
    const { ports } = record({ asyncFails: stopping });
    const sink = createClientSink(ports);
    const ended = new AbortController();
    ended.abort(stopping);
    sink.write(encode("x"));
    await expect(sink.flush(ended.signal)).rejects.toBe(stopping);
  });
});
