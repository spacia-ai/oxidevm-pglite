import { BaseFilesystem } from "@electric-sql/pglite/basefs";
import type { FsStats } from "@electric-sql/pglite/basefs";
import { errorText, toError } from "./errors.ts";
import type { Descriptor, KitDirectory, KitErrno, SyncFiles } from "./ports.ts";

/** The VM file operations the database files need. */
export type VmFiles = Pick<SyncFiles, "open" | "close" | "seek" | "read" | "write" | "fsync" | "lstat" | "fstat" | "mkdir" | "rename" | "unlink" | "readdir" | "chmod" | "truncate" | "utimes">;
type FileStat = ReturnType<VmFiles["lstat"]>;

export interface VmFsPorts {
  readonly files: VmFiles;
  readonly errno: KitErrno;
  readonly directory: KitDirectory;
  /** Where a flush failure that nobody awaited is reported. */
  readonly log?: (line: string) => void;
}

/** Linux x86-64 open flags and errno values. */
const O_WRONLY = 0o1, O_RDWR = 0o2, O_CREAT = 0o100, O_EXCL = 0o200, O_TRUNC = 0o1000, O_APPEND = 0o2000;
const S_IFMT = 0o170000, S_IFDIR = 0o040000;
const EIO = 5, ENOENT = 2, EBADF = 9, EEXIST = 17;

/** Node-style open modes, as PostgreSQL's Emscripten file system passes them. */
const OPEN_FLAGS: ReadonlyMap<string, number> = new Map([
  ["r", 0],
  ["r+", O_RDWR],
  ["w", O_WRONLY | O_CREAT | O_TRUNC],
  ["w+", O_RDWR | O_CREAT | O_TRUNC],
  ["wx", O_WRONLY | O_CREAT | O_TRUNC | O_EXCL],
  ["wx+", O_RDWR | O_CREAT | O_TRUNC | O_EXCL],
  ["a", O_WRONLY | O_CREAT | O_APPEND],
  ["a+", O_RDWR | O_CREAT | O_APPEND],
  ["ax", O_WRONLY | O_CREAT | O_APPEND | O_EXCL],
  ["ax+", O_RDWR | O_CREAT | O_APPEND | O_EXCL],
]);

const PERMISSION_BITS = 0o7777;
/** One read or write call moves at most this many bytes. */
const MAX_IO_BYTES = 16 * 1024 ** 2;

interface OpenFile { readonly fd: Descriptor; path: string }

/**
 * PostgreSQL's data directory as live files of the VM: every page PostgreSQL writes lands in the shared
 * Linux file system, so native programs see the same files. Paths are confined to `root`, host failures
 * become the Emscripten errno PostgreSQL's file system layer expects, and `flushSync` makes the changed
 * files durable before their directories (a rename or unlink is only as durable as its parent directory).
 */
export class VMPostgresFS extends BaseFilesystem {
  readonly #root: string;
  readonly #ports: VmFsPorts;
  readonly #descriptors = new Map<number, OpenFile>();
  readonly #dirty = new Set<string>();
  /** A flush that failed while nobody was waiting for it; the next change reports it. */
  #deferred: { readonly error: unknown } | undefined;

  constructor(root: string, ports: VmFsPorts) {
    super(root);
    this.#root = root;
    this.#ports = ports;
  }

  #call<T>(operation: () => T): T {
    try {
      return operation();
    } catch (error: unknown) {
      const errno = this.#ports.errno.of(error);
      if (errno === undefined) throw error;
      throw this.#failure(error instanceof Error ? error.message : "Linux filesystem failure", errno);
    }
  }

  /** An error PostgreSQL's file system layer turns into `FS.ErrnoError(code)`. */
  #failure(message: string, linuxErrno: number): Error {
    return Object.assign(new Error(message), { code: this.#ports.errno.toEmscripten(linuxErrno) });
  }

  #target(path: string): string {
    const parts = path.split("/").filter(part => part !== "");
    if (parts.some(part => part === "." || part === ".." || part.includes("\0"))) throw new Error("Invalid PostgreSQL filesystem path");
    return parts.length === 0 ? this.#root : `${this.#root}/${parts.join("/")}`;
  }

  #changed(path: string): void {
    this.#dirty.add(path);
    this.#dirty.add(path.slice(0, path.lastIndexOf("/")) || "/");
  }

  #descriptor(fd: number): OpenFile {
    const item = this.#descriptors.get(fd);
    if (item === undefined) throw this.#failure("Bad database descriptor", EBADF);
    return item;
  }

  /** Reports, once, a flush that failed after the statement that caused it had been answered. */
  #assertWritable(): void {
    if (this.#deferred === undefined) return;
    const { error } = this.#deferred;
    this.#deferred = undefined;
    throw this.#failure(`The database storage failed to flush earlier: ${errorText(error)}`, EIO);
  }

  #stats(value: FileStat): FsStats {
    return {
      dev: Number(value.device), ino: Number(value.inode), mode: value.mode, nlink: Number(value.links), uid: value.uid, gid: value.gid,
      rdev: 0, size: Number(value.size), blksize: 4096, blocks: Math.ceil(Number(value.size) / 512),
      atime: Number(value.accessedNs / 1_000_000n), mtime: Number(value.modifiedNs / 1_000_000n), ctime: Number(value.changedNs / 1_000_000n),
    };
  }

  override chmod(path: string, mode: number): void {
    this.#call(() => {
      this.#assertWritable();
      const target = this.#target(path);
      this.#ports.files.chmod(target, mode & PERMISSION_BITS);
      this.#changed(target);
    });
  }

  /** PostgreSQL's file system layer gives times as milliseconds since the epoch; the host takes them as dates, to the millisecond. */
  override utimes(path: string, atime: number, mtime: number): void {
    this.#call(() => {
      const accessed = new Date(atime), modified = new Date(mtime);
      if (Number.isNaN(accessed.getTime()) || Number.isNaN(modified.getTime())) throw new Error("Invalid database file time");
      this.#assertWritable();
      const target = this.#target(path);
      this.#ports.files.utimes(target, accessed, modified, { followLinks: true });
      this.#changed(target);
    });
  }

  override truncate(path: string, length: number): void {
    this.#call(() => {
      if (!Number.isSafeInteger(length) || length < 0) throw new Error("Invalid database file length");
      this.#assertWritable();
      const target = this.#target(path);
      this.#ports.files.truncate(target, length);
      this.#changed(target);
    });
  }

  override open(path: string, mode = "r+", permissions = 0o600): number {
    return this.#call(() => {
      const flags = OPEN_FLAGS.get(mode);
      if (flags === undefined) throw new Error(`Unsupported database file flags: ${mode}`);
      const changes = (flags & (O_CREAT | O_TRUNC)) !== 0;
      if (changes) this.#assertWritable();
      const target = this.#target(path);
      const fd = this.#ports.files.open(target, flags, permissions & PERMISSION_BITS);
      this.#descriptors.set(fd, { fd, path: target });
      if (changes) this.#changed(target);
      return fd;
    });
  }

  override close(fd: number): void {
    this.#call(() => {
      this.#ports.files.close(this.#descriptor(fd).fd);
      this.#descriptors.delete(fd);
    });
  }

  override lstat(path: string): FsStats {
    return this.#call(() => this.#stats(this.#ports.files.lstat(this.#target(path))));
  }

  override fstat(fd: number): FsStats {
    return this.#call(() => this.#stats(this.#ports.files.fstat(this.#descriptor(fd).fd)));
  }

  override mkdir(path: string, options?: { recursive?: boolean; mode?: number }): void {
    this.#call(() => {
      this.#assertWritable();
      const target = this.#target(path);
      const mode = (options?.mode ?? 0o700) & PERMISSION_BITS;
      if (options?.recursive !== true) {
        this.#ports.files.mkdir(target, mode);
        this.#changed(target);
        return;
      }
      let current = "";
      for (const part of target.split("/").filter(name => name !== "")) {
        current += `/${part}`;
        try {
          this.#ports.files.mkdir(current, mode);
          this.#changed(current);
        } catch (error: unknown) {
          if (this.#ports.errno.of(error) !== EEXIST) throw error;
        }
      }
    });
  }

  override readdir(path: string): string[] {
    return this.#call(() => this.#ports.files.readdir(this.#target(path)).map(entry => entry.name).filter(name => name !== "." && name !== ".."));
  }

  override rename(oldPath: string, newPath: string): void {
    this.#call(() => {
      this.#assertWritable();
      const from = this.#target(oldPath), to = this.#target(newPath);
      this.#ports.files.rename(from, to);
      for (const item of this.#descriptors.values()) if (item.path === from) item.path = to;
      this.#changed(from);
      this.#changed(to);
    });
  }

  override unlink(path: string): void {
    this.#call(() => {
      this.#assertWritable();
      const target = this.#target(path);
      this.#ports.files.unlink(target);
      this.#changed(target);
    });
  }

  override rmdir(path: string): void {
    this.#call(() => {
      this.#assertWritable();
      const target = this.#target(path);
      this.#ports.files.unlink(target, true);
      this.#changed(target);
    });
  }

  override read(fd: number, buffer: Uint8Array, offset: number, length: number, position: number): number {
    return this.#call(() => {
      const { fd: descriptor } = this.#descriptor(fd);
      this.#ports.files.seek(descriptor, BigInt(position), "start");
      const data = this.#ports.files.read(descriptor, Math.min(length, MAX_IO_BYTES));
      buffer.set(data, offset);
      return data.length;
    });
  }

  override write(fd: number, buffer: Uint8Array | ArrayBuffer, offset: number, length: number, position: number): number {
    return this.#call(() => {
      this.#assertWritable();
      const item = this.#descriptor(fd);
      const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
      this.#ports.files.seek(item.fd, BigInt(position), "start");
      const count = this.#ports.files.write(item.fd, bytes.subarray(offset, offset + Math.min(length, MAX_IO_BYTES)));
      this.#changed(item.path);
      return count;
    });
  }

  override writeFile(path: string, data: string | Uint8Array, options?: { encoding?: string; mode?: number; flag?: string }): void {
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
    const fd = this.open(path, options?.flag ?? "w", options?.mode ?? 0o600);
    try {
      let offset = 0;
      while (offset < bytes.length) {
        const count = this.write(fd, bytes, offset, bytes.length - offset, offset);
        if (count === 0) throw new Error("Database write made no progress");
        offset += count;
      }
    } finally {
      this.close(fd);
    }
  }

  /**
   * Makes every change since the last flush durable: file contents first, then the directories that hold
   * them, deepest first, so that a crash never leaves a durable directory entry for lost contents. A
   * failure keeps everything marked as changed, so the next flush retries it.
   */
  flushSync(): void {
    const directories: string[] = [];
    for (const path of Array.from(this.#dirty)) {
      let stat: FileStat;
      try {
        stat = this.#ports.files.lstat(path);
      } catch (error: unknown) {
        if (this.#ports.errno.of(error) === ENOENT) continue;
        throw error;
      }
      if ((stat.mode & S_IFMT) === S_IFDIR) directories.push(path);
      else this.#ports.directory.sync(this.#ports.files, path, "file");
    }
    for (const path of directories.sort((left, right) => right.length - left.length)) this.#ports.directory.sync(this.#ports.files, path, "directory");
    this.#dirty.clear();
  }

  /** PGlite calls this after every statement; with relaxed durability nobody awaits it, so a failure is kept for the next change. */
  override syncToFs(relaxedDurability?: boolean): Promise<void> {
    try {
      this.flushSync();
    } catch (error: unknown) {
      if (relaxedDurability !== true) return Promise.reject(toError(error));
      this.#deferred = { error };
      this.#ports.log?.(`database flush failed after the statement was answered: ${errorText(error)}`);
    }
    return Promise.resolve();
  }

  override async closeFs(): Promise<void> {
    await this.syncToFs();
    for (const fd of Array.from(this.#descriptors.keys())) this.close(fd);
  }
}
