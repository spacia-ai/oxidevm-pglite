import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { kit } from "@oxidevm/sdk/wasm";
import type { HostOf } from "@oxidevm/sdk/wasm";
import { GUEST_FILES } from "../../src/layout.ts";
import type definition from "../../module.ts";
import { backendMessages } from "./wire.ts";
import type { Backend } from "./wire.ts";
import { createNodeFiles, descriptor, processId, text } from "./node-files.ts";
import type { NodeFilesHarness } from "./node-files.ts";

type Host = HostOf<(typeof definition)["manifest"]>;
type FileDescriptor = ReturnType<typeof descriptor>;

const REPOSITORY = path.join(import.meta.dirname, "../..");
const PGLITE_DIST = path.join(REPOSITORY, "node_modules/@electric-sql/pglite/dist");
const WORKSPACE = "/workspace";

interface Pipe { chunks: Uint8Array[]; onWrite?: (bytes: Uint8Array) => void }

function unsupported(name: string): () => never {
  return () => { throw new Error(`${name} is not part of the fake VM`); };
}

export interface FakeVmOptions {
  readonly dataDir?: string;
  readonly durability?: "relaxed" | "strict";
  readonly legacyIndexedDb?: string;
}

/**
 * A small VM for the adapter: the workspace is a temporary directory, `process.spawn` starts JavaScript stand-ins
 * for the two Python helpers (the real scripts have their own tests), and the host members are complete, so the
 * adapter is type-checked against its real host type.
 */
export class FakeVm {
  readonly root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pglite-vm-")));
  readonly harness: NodeFilesHarness = createNodeFiles(virtual => this.translate(virtual));
  readonly logs: string[] = [];
  readonly spawned: { readonly command: string; readonly args: readonly string[]; readonly stdoutIs: string }[] = [];
  readonly signals: number[] = [];
  readonly waited: number[] = [];
  /** What each client socket received through a writer helper, by socket label. */
  readonly clientBytes = new Map<string, Uint8Array[]>();
  readonly utimes: { readonly path: string; readonly atimeMs: number; readonly mtimeMs: number }[] = [];
  readonly #pipes = new Map<number, Pipe>();
  readonly #labels = new Map<number, string>([[1, "terminal"]]);
  /** Descriptors made by `dup`: they exist only in this fake, not on this machine. */
  readonly #duplicates = new Set<number>();
  #next = 500;

  constructor(readonly options: FakeVmOptions = {}) {
    fs.mkdirSync(path.join(this.root, "workspace"));
  }

  translate(virtual: string): string {
    if (virtual === WORKSPACE) return path.join(this.root, "workspace");
    return virtual.startsWith(`${WORKSPACE}/`) ? path.join(this.root, "workspace", virtual.slice(WORKSPACE.length + 1)) : virtual;
  }

  /** The path of a workspace file on this machine. */
  real(virtual: string): string {
    return this.translate(virtual);
  }

  dispose(): void {
    fs.rmSync(this.root, { recursive: true, force: true });
  }

  /** Gives a client socket a label, so that what the writer helper sends it can be told apart. */
  socket(label: string): FileDescriptor {
    const fd = descriptor(this.#next++);
    this.#labels.set(fd, label);
    return fd;
  }

  received(label: string): Backend[] {
    const parts = this.clientBytes.get(label) ?? [];
    return backendMessages(Buffer.concat(parts));
  }

  #pipe(onWrite?: Pipe["onWrite"]): FileDescriptor {
    const fd = descriptor(this.#next++);
    this.#pipes.set(fd, onWrite === undefined ? { chunks: [] } : { chunks: [], onWrite });
    return fd;
  }

  #reply(fd: FileDescriptor, line: string): void {
    this.#pipes.get(fd)?.chunks.push(new TextEncoder().encode(line));
  }

  #read(fd: FileDescriptor, count: number): Uint8Array {
    const pipe = this.#pipes.get(fd);
    const next = pipe?.chunks.shift();
    if (next === undefined) return new Uint8Array(0);
    if (next.length > count) { pipe?.chunks.unshift(next.subarray(count)); return next.subarray(0, count); }
    return next;
  }

  /** The metadata helper: sets file times, as pg-metadata.py does. */
  #startMetadata(): { stdin: FileDescriptor; stdout: FileDescriptor } {
    const stdout = this.#pipe();
    const stdin = this.#pipe(bytes => {
      const request: unknown = JSON.parse(new TextDecoder().decode(bytes));
      const fields = typeof request === "object" && request !== null ? request : {};
      const target = String(Reflect.get(fields, "path")), atimeMs = Number(Reflect.get(fields, "atimeMs")), mtimeMs = Number(Reflect.get(fields, "mtimeMs"));
      this.utimes.push({ path: target, atimeMs, mtimeMs });
      fs.utimesSync(this.translate(target), atimeMs / 1000, mtimeMs / 1000);
      this.#reply(stdout, '{"ok":true}\n');
    });
    return { stdin, stdout };
  }

  /** The writer helper: copies the spool to the socket that was descriptor 1 when it started, as pg-writer.py does. */
  #startWriter(spool: string): { stdin: FileDescriptor; stderr: FileDescriptor } {
    const label = this.#labels.get(1) ?? "terminal";
    const stderr = this.#pipe();
    const stdin = this.#pipe(bytes => {
      if (new TextDecoder().decode(bytes) !== "send\n") { this.#reply(stderr, '{"ok":false,"error":"Invalid response writer command"}\n'); return; }
      const sent = fs.readFileSync(this.translate(spool));
      this.clientBytes.set(label, [...(this.clientBytes.get(label) ?? []), Uint8Array.from(sent)]);
      this.#reply(stderr, '{"ok":true}\n');
    });
    return { stdin, stderr };
  }

  host(): Host {
    const files = this.harness.files;
    const pipeWrite = (fd: FileDescriptor, bytes: Uint8Array): boolean => {
      const pipe = this.#pipes.get(fd);
      if (pipe === undefined) return false;
      pipe.onWrite?.(bytes);
      return true;
    };
    const fsHost: Host["fs"] = {
      ...files,
      read: (fd, count) => this.#pipes.has(fd) ? this.#read(fd, count) : files.read(fd, count),
      writeAll: (fd, bytes) => { if (!pipeWrite(fd, bytes)) files.writeAll(fd, bytes); },
      close: fd => { if (!this.#pipes.delete(fd) && !this.#duplicates.delete(fd)) files.close(fd); },
      dup: (source, target) => {
        const label = this.#labels.get(source) ?? String(source);
        if (target !== undefined) { this.#labels.set(target, label); return target; }
        const copy = descriptor(this.#next++);
        this.#labels.set(copy, label);
        this.#duplicates.add(copy);
        return copy;
      },
      pipe: unsupported("pipe"), realpath: unsupported("realpath"), fchmod: unsupported("fchmod"), ftruncate: unsupported("ftruncate"),
      link: unsupported("link"), symlink: unsupported("symlink"), readlink: unsupported("readlink"),
    };
    const asyncFiles: Host["files"] = {
      read: (fd, count) => Promise.resolve(this.#pipes.has(fd) ? this.#read(fd, count) : new Uint8Array(0)),
      writeAll: (fd, bytes) => { pipeWrite(fd, bytes); return Promise.resolve(); },
      close: fd => { this.#pipes.delete(fd); return Promise.resolve(); },
      open: unsupported("open"), write: unsupported("write"), seek: unsupported("seek"), dup: unsupported("dup"), pipe: unsupported("pipe"), stat: unsupported("stat"),
      lstat: unsupported("lstat"), fstat: unsupported("fstat"), readdir: unsupported("readdir"), realpath: unsupported("realpath"), mkdir: unsupported("mkdir"),
      rename: unsupported("rename"), unlink: unsupported("unlink"), fsync: unsupported("fsync"), chmod: unsupported("chmod"), fchmod: unsupported("fchmod"),
      truncate: unsupported("truncate"), ftruncate: unsupported("ftruncate"), link: unsupported("link"), symlink: unsupported("symlink"),
      readlink: unsupported("readlink"), readFile: unsupported("readFile"), writeFile: unsupported("writeFile"),
    };
    const stdout = descriptor(1);
    return {
      signal: new AbortController().signal,
      options: { dataDir: this.options.dataDir ?? "/workspace/pgdata", durability: this.options.durability ?? "strict", legacyIndexedDb: this.options.legacyIndexedDb ?? "" },
      artifacts: {
        compile: async name => WebAssembly.compile(fs.readFileSync(path.join(PGLITE_DIST, name))),
        bytes: name => Promise.resolve(Uint8Array.from(this.#artifact(name))),
        url: name => `https://modules.invalid/${name}`,
      },
      kit,
      stdio: { stdin: descriptor(0), stdout, stderr: descriptor(2) },
      log: line => { this.logs.push(line); },
      fail: status => status,
      fs: fsHost,
      files: asyncFiles,
      process: {
        info: () => Promise.resolve({ pid: processId(4321), parentPid: null, uid: 1000, gid: 1000, cwd: "/workspace", args: [], environment: [], terminal: null }),
        cwd: () => Promise.resolve("/workspace"),
        spawn: spec => {
          const args = spec.args ?? [];
          this.spawned.push({ command: spec.command, args, stdoutIs: this.#labels.get(1) ?? "terminal" });
          const pid = processId(9000 + this.spawned.length);
          if (args[1]?.endsWith("pg-metadata.py") === true) return Promise.resolve({ pid, ...this.#startMetadata(), stderr: null });
          if (args[1]?.endsWith("pg-writer.py") === true) {
            const { stdin, stderr } = this.#startWriter(args[2] ?? "");
            return Promise.resolve({ pid, stdin, stdout: null, stderr });
          }
          return Promise.reject(new Error(`The fake VM cannot run ${spec.command}`));
        },
        wait: pid => { this.waited.push(pid); return Promise.resolve({ kind: "exited" as const, code: 0 }); },
        signal: (_pid, signal) => { this.signals.push(signal); return Promise.resolve(); },
      },
    };
  }

  #artifact(name: string): Uint8Array {
    const guest = GUEST_FILES.find(file => file.artifact === name);
    if (guest !== undefined) return fs.readFileSync(path.join(REPOSITORY, "guest", name));
    if (name === "NOTICES.txt") return fs.readFileSync(path.join(REPOSITORY, "NOTICES.txt"));
    return fs.readFileSync(path.join(PGLITE_DIST, name));
  }

  /** Text of a workspace file. */
  read(virtual: string): string {
    return fs.readFileSync(this.translate(virtual), "utf8");
  }

  exists(virtual: string): boolean {
    return fs.existsSync(this.translate(virtual));
  }
}

export { text };
