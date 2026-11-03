import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { kit } from "@oxidevm/sdk/wasm";
import type { HostOf } from "@oxidevm/sdk/wasm";
import type definition from "../../module.ts";
import { createNodeFiles, descriptor, processId } from "./node-files.ts";
import type { NodeFilesHarness } from "./node-files.ts";

type Host = HostOf<(typeof definition)["manifest"]>;
type FileDescriptor = ReturnType<typeof descriptor>;

const REPOSITORY = path.join(import.meta.dirname, "../..");
const PGLITE_DIST = path.join(REPOSITORY, "node_modules/@electric-sql/pglite/dist");
const WORKSPACE = "/workspace";
/** The members of `process` the manifest does not grant: reaching for one is a failure. */
const FORBIDDEN = new Set(["spawn", "wait", "signal", "chdir"]);

export interface FakeVmOptions {
  readonly dataDir?: string;
  readonly durability?: "relaxed" | "strict";
  readonly importArchive?: string;
}

/**
 * A small VM for the adapter: the workspace is a temporary directory, and the host members are complete, so the
 * adapter is type-checked against its real host type. `process` is a proxy that fails the moment the adapter reaches
 * for anything the manifest does not grant (the type system already forbids it; this proves it at run time), and
 * remembers what it was asked for.
 */
export class FakeVm {
  readonly root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pglite-vm-")));
  readonly harness: NodeFilesHarness = createNodeFiles(virtual => this.translate(virtual));
  readonly logs: string[] = [];
  /** The members of `process` the adapter looked up, in order. */
  readonly processTouched: string[] = [];
  /** What the adapter wrote to a client socket with the synchronous `writeAll`, by descriptor. */
  readonly socketWrites: { readonly fd: number; readonly bytes: Uint8Array; readonly options: unknown }[] = [];
  readonly #sockets = new Map<number, ((count: number) => Uint8Array) | undefined>();

  constructor(readonly options: FakeVmOptions = {}) {
    fs.mkdirSync(path.join(this.root, "workspace"));
  }

  translate(virtual: string): string {
    if (virtual === WORKSPACE) return path.join(this.root, "workspace");
    return virtual.startsWith(`${WORKSPACE}/`) ? path.join(this.root, "workspace", virtual.slice(WORKSPACE.length + 1)) : virtual;
  }

  dispose(): void {
    fs.rmSync(this.root, { recursive: true, force: true });
  }

  /**
   * Marks a descriptor as a client socket: synchronous writes to it are recorded, not written to a file, and
   * synchronous reads come from `source` (the client's COPY data).
   */
  socket(fd: FileDescriptor, source?: (count: number) => Uint8Array): void {
    this.#sockets.set(fd, source);
  }

  host(): Host {
    const files = this.harness.files;
    const base: Host["process"] = {
      info: () => Promise.resolve({ pid: processId(4321), parentPid: null, uid: 1000, gid: 1000, cwd: "/workspace", args: [], environment: [], terminal: null }),
      cwd: () => Promise.resolve("/workspace"),
    };
    const guarded = new Proxy(base, {
      get: (target, property, receiver) => {
        this.processTouched.push(String(property));
        if (typeof property === "string" && FORBIDDEN.has(property)) throw new Error(`The adapter reached for process.${property}, which its manifest does not grant`);
        const member: unknown = Reflect.get(target, property, receiver);
        return member;
      },
    });
    const unsupported = (name: string): (() => never) => () => { throw new Error(`${name} is not part of the fake VM`); };
    // Built apart from the literal below so that it also type-checks against SDKs whose artifacts have no `blob` or `bytesSync`.
    type ArtifactName = Parameters<Host["artifacts"]["bytes"]>[0];
    const artifacts = {
      compile: async (name: ArtifactName) => WebAssembly.compile(fs.readFileSync(path.join(PGLITE_DIST, name))),
      bytes: (name: ArtifactName) => Promise.resolve(Uint8Array.from(this.#artifact(name))),
      bytesSync: (name: ArtifactName) => Uint8Array.from(this.#artifact(name)),
      blob: (name: ArtifactName) => new Blob([Uint8Array.from(this.#artifact(name))]),
      url: (name: ArtifactName) => `https://modules.invalid/${name}`,
    };
    return {
      signal: new AbortController().signal,
      options: { dataDir: this.options.dataDir ?? "/workspace/pgdata", durability: this.options.durability ?? "strict", importArchive: this.options.importArchive ?? "" },
      artifacts,
      kit,
      stdio: { stdin: descriptor(0), stdout: descriptor(1), stderr: descriptor(2) },
      log: line => { this.logs.push(line); },
      fail: status => status,
      fs: {
        ...files,
        read: (fd, count) => {
          const source = this.#sockets.get(fd);
          return source === undefined ? files.read(fd, count) : source(count);
        },
        writeAll: (fd, bytes, options) => {
          if (this.#sockets.has(fd)) this.socketWrites.push({ fd, bytes: bytes.slice(), options });
          else files.writeAll(fd, bytes, options);
        },
        dup: unsupported("dup"), pipe: unsupported("pipe"), realpath: unsupported("realpath"), fchmod: unsupported("fchmod"), ftruncate: unsupported("ftruncate"),
        link: unsupported("link"), symlink: unsupported("symlink"), readlink: unsupported("readlink"),
      },
      process: guarded,
    };
  }

  #artifact(name: string): Uint8Array {
    if (name === "oxidevm_pglite.py") return fs.readFileSync(path.join(REPOSITORY, "guest", name));
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
