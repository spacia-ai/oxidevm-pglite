import fs from "node:fs";
import { LinuxError } from "@oxidevm/sdk/js-process";
import type { NativeProcesses } from "../../src/ports.ts";
import type { FileDescriptor, LinuxDirectoryEntry, LinuxFileStat, LinuxPath, LinuxSyncWriteOptions, LinuxTimeOptions, LinuxTimestamp, SeekOrigin } from "@oxidevm/sdk/js-process";

/** The VM file operations the adapter's modules use, backed by a real directory of the machine running the test. */
export interface NodeFiles {
  open(path: LinuxPath, flags?: number, mode?: number): FileDescriptor;
  close(fd: FileDescriptor): void;
  seek(fd: FileDescriptor, offset: bigint, origin?: SeekOrigin): bigint;
  read(fd: FileDescriptor, count: number): Uint8Array;
  write(fd: FileDescriptor, bytes: Uint8Array, options?: LinuxSyncWriteOptions): number;
  writeAll(fd: FileDescriptor, bytes: Uint8Array, options?: LinuxSyncWriteOptions): void;
  fsync(fd: FileDescriptor): void;
  lstat(path: LinuxPath): LinuxFileStat;
  stat(path: LinuxPath): LinuxFileStat;
  fstat(fd: FileDescriptor): LinuxFileStat;
  mkdir(path: LinuxPath, mode?: number): void;
  rename(from: LinuxPath, to: LinuxPath): void;
  unlink(path: LinuxPath, directory?: boolean): void;
  readdir(path: LinuxPath): readonly LinuxDirectoryEntry[];
  chmod(path: LinuxPath, mode: number): void;
  truncate(path: LinuxPath, length: bigint | number): void;
  utimes(path: LinuxPath, access: LinuxTimestamp, modification: LinuxTimestamp, options?: LinuxTimeOptions): void;
  readFile(path: LinuxPath, maxBytes?: number): Uint8Array;
  writeFile(path: LinuxPath, bytes: Uint8Array): void;
}

export interface NodeFilesHarness {
  readonly files: NodeFiles;
  /** Every `utimes`, as the host received it. */
  readonly times: { readonly path: string; readonly access: LinuxTimestamp; readonly modification: LinuxTimestamp; readonly options: LinuxTimeOptions | undefined }[];
  /** Every `fsync`, as `fsync:<path>` in call order. */
  readonly syncs: string[];
  /** Every `fsync`, `rename` and `mkdir`, in call order, for tests of the order in which things become durable. */
  readonly ops: string[];
  /** Makes later `fsync` calls fail: all of them, or those for which the function says so, until it is set back to `false`. */
  failFsync: boolean | ((path: string) => boolean);
}

type ProcessId = Parameters<NativeProcesses["wait"]>[0];

function isProcessId(value: number): value is ProcessId {
  return Number.isSafeInteger(value) && value > 0;
}

/** A process id the way the host returns one. */
export function processId(value: number): ProcessId {
  if (!isProcessId(value)) throw new RangeError(`${String(value)} is not a process id`);
  return value;
}

function isDescriptor(value: number): value is FileDescriptor {
  return Number.isSafeInteger(value) && value >= 0;
}

/** A descriptor number the way the host returns one; the brand exists only in the type system. */
export function descriptor(value: number): FileDescriptor {
  if (!isDescriptor(value)) throw new RangeError(`${String(value)} is not a descriptor`);
  return value;
}

/** Runs a Node file operation and reports its failure the way the host does: as a `LinuxError` with a positive errno. */
function linux<T>(run: () => T): T {
  try {
    return run();
  } catch (error: unknown) {
    if (error instanceof Error && "errno" in error && typeof error.errno === "number") throw new LinuxError(Math.abs(error.errno));
    throw error;
  }
}

/** A path argument of the host as text (the host takes text or raw bytes). */
export function text(path: LinuxPath): string {
  return typeof path === "string" ? path : new TextDecoder().decode(path);
}

function convert(value: fs.BigIntStats): LinuxFileStat {
  return {
    device: value.dev, inode: value.ino, links: value.nlink, mode: Number(value.mode), uid: Number(value.uid), gid: Number(value.gid),
    size: value.size, accessedNs: value.atimeNs, modifiedNs: value.mtimeNs, changedNs: value.ctimeNs,
  };
}

/** @param translate maps the path a program asks for to the path on this machine (identity by default). */
export function createNodeFiles(translate: (path: string) => string = path => path): NodeFilesHarness {
  const real = (path: LinuxPath): string => translate(text(path));
  const positions = new Map<number, number>(), paths = new Map<number, string>();
  const harness: NodeFilesHarness = {
    syncs: [],
    ops: [],
    times: [],
    failFsync: false,
    files: {
      open(path, flags = 0, mode = 0o600) {
        const name = text(path);
        const fd = linux(() => fs.openSync(translate(name), flags, mode));
        positions.set(fd, 0);
        paths.set(fd, name);
        return descriptor(fd);
      },
      close(fd) {
        positions.delete(fd);
        paths.delete(fd);
        linux(() => { fs.closeSync(fd); });
      },
      seek(fd, offset, origin = "start") {
        const base = origin === "start" ? 0 : origin === "current" ? positions.get(fd) ?? 0 : fs.fstatSync(fd).size;
        positions.set(fd, base + Number(offset));
        return BigInt(base + Number(offset));
      },
      read(fd, count) {
        const buffer = Buffer.alloc(count), position = positions.get(fd) ?? 0;
        const got = linux(() => fs.readSync(fd, buffer, 0, count, position));
        positions.set(fd, position + got);
        return buffer.subarray(0, got);
      },
      write(fd, bytes) {
        const position = positions.get(fd) ?? 0;
        const wrote = linux(() => fs.writeSync(fd, bytes, 0, bytes.length, position));
        positions.set(fd, position + wrote);
        return wrote;
      },
      writeAll(fd, bytes) {
        let offset = 0;
        while (offset < bytes.length) offset += harness.files.write(fd, bytes.subarray(offset));
      },
      fsync(fd) {
        const path = paths.get(fd) ?? String(fd);
        if (typeof harness.failFsync === "function" ? harness.failFsync(path) : harness.failFsync) throw new Error("Injected storage flush failure");
        harness.syncs.push(`fsync:${path}`);
        harness.ops.push(`fsync:${path}`);
        linux(() => { fs.fsyncSync(fd); });
      },
      lstat: path => linux(() => convert(fs.lstatSync(real(path), { bigint: true }))),
      stat: path => linux(() => convert(fs.statSync(real(path), { bigint: true }))),
      fstat: fd => linux(() => convert(fs.fstatSync(fd, { bigint: true }))),
      mkdir(path, mode = 0o777) { harness.ops.push(`mkdir:${text(path)}`); linux(() => { fs.mkdirSync(real(path), { mode }); }); },
      rename(from, to) { harness.ops.push(`rename:${text(from)}->${text(to)}`); linux(() => { fs.renameSync(real(from), real(to)); }); },
      unlink(path, directory = false) {
        linux(() => { if (directory) fs.rmdirSync(real(path)); else fs.unlinkSync(real(path)); });
      },
      readdir: path => linux(() => fs.readdirSync(real(path), { withFileTypes: true }).map((entry): LinuxDirectoryEntry => ({
        name: entry.name, nameBytes: new TextEncoder().encode(entry.name), type: entry.isDirectory() ? 4 : 8,
      }))),
      chmod(path, mode) { linux(() => { fs.chmodSync(real(path), mode & 0o7777); }); },
      truncate(path, length) { linux(() => { fs.truncateSync(real(path), Number(length)); }); },
      utimes(path, access, modification, options) {
        harness.times.push({ path: text(path), access, modification, options });
        const now = new Date();
        const current = (): fs.Stats => linux(() => fs.statSync(real(path)));
        const resolve = (time: LinuxTimestamp, existing: () => Date): Date => time === "now" ? now : time === "omit" ? existing() : time;
        const accessed = resolve(access, () => current().atime), modified = resolve(modification, () => current().mtime);
        linux(() => { if (options?.followLinks === false) fs.lutimesSync(real(path), accessed, modified); else fs.utimesSync(real(path), accessed, modified); });
      },
      readFile: (path, maxBytes) => {
        const bytes = linux(() => fs.readFileSync(real(path)));
        if (maxBytes !== undefined && bytes.length > maxBytes) throw new LinuxError(27);
        return bytes;
      },
      writeFile(path, bytes) { linux(() => { fs.writeFileSync(real(path), bytes); }); },
    },
  };
  return harness;
}
