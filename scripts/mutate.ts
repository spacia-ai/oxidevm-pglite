// A small mutation test of the logic this module ported: it changes one thing at a time in the source (a byte order, a
// limit, a comparison, a path check), runs the tests that should notice, and reports any change they let through.
//
//   node scripts/mutate.ts          run every mutation; the exit status is 1 when one survived
//   node scripts/mutate.ts wire     only those whose id starts with "wire"
//
// The working tree must be clean in the files it mutates: each file is restored after its mutation, even on failure.
import { execFile, execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");

interface Mutation {
  readonly id: string;
  readonly file: string;
  /** Text that occurs exactly once in the file. */
  readonly find: string;
  readonly replace: string;
  readonly tests: readonly string[];
}

const WIRE = ["test/wire.test.ts", "test/wire-copy.test.ts"];
const FS = ["test/vm-fs.test.ts"];

export const MUTATIONS: readonly Mutation[] = [
  { id: "framing-int32-little-endian", file: "src/bytes.ts", find: "setUint32(0, value);", replace: "setUint32(0, value, true);", tests: ["test/bytes.test.ts"] },
  { id: "framing-number32-little-endian", file: "src/bytes.ts", find: ".getUint32(0);", replace: ".getUint32(0, true);", tests: ["test/bytes.test.ts"] },
  { id: "framing-packet-length", file: "src/wire.ts", find: "int32(data.length + 4)", replace: "int32(data.length + 5)", tests: WIRE },
  { id: "framing-backend-header", file: "src/wire.ts", find: "Math.min(5 - this.#headerSize,", replace: "Math.min(4 - this.#headerSize,", tests: WIRE },
  { id: "framing-minimum-packet-length", file: "src/wire.ts", find: 'if (length < 4) throw new Error("Invalid PostgreSQL packet length");', replace: 'if (length < 3) throw new Error("Invalid PostgreSQL packet length");', tests: WIRE },
  { id: "framing-frontend-limit", file: "src/wire.ts", find: "const MAX_FRONTEND_BYTES = 16 * 1024 ** 2;", replace: "const MAX_FRONTEND_BYTES = 32 * 1024 ** 2;", tests: WIRE },
  { id: "framing-terminate-length", file: "src/wire.ts", find: "if (frontend.length !== 5)", replace: "if (frontend.length !== 6)", tests: WIRE },
  { id: "framing-request-limit", file: "src/json-endpoint.ts", find: "if (length > MAX_REQUEST_BYTES)", replace: "if (length >= MAX_REQUEST_BYTES)", tests: ["test/json-endpoint.test.ts"] },
  { id: "framing-reply-limit", file: "src/json-endpoint.ts", find: "if (bytes.length > MAX_REPLY_BYTES)", replace: "if (bytes.length >= MAX_REPLY_BYTES)", tests: ["test/json-endpoint.test.ts"] },
  { id: "framing-parameter-limit", file: "src/json-endpoint.ts", find: "params.length > MAX_PARAMS", replace: "params.length >= MAX_PARAMS", tests: ["test/json-endpoint.test.ts"] },
  { id: "framing-request-keys", file: "src/json-endpoint.ts", find: '!exactKeys(parsed, ["sql", "params"])', replace: "false", tests: ["test/json-endpoint.test.ts"] },
  { id: "framing-silent-on-hangup", file: "src/json-endpoint.ts", find: "if (peer.ended) return;", replace: "if (peer.ended && false) return;", tests: ["test/json-endpoint.test.ts"] },
  { id: "gate-wait-length", file: "src/session.ts", find: "export const SESSION_WAIT_MS = 250;", replace: "export const SESSION_WAIT_MS = 2500;", tests: ["test/session.test.ts"] },
  { id: "gate-deadline-comparison", file: "src/session.ts", find: "if (clock.now() > deadline)", replace: "if (clock.now() >= deadline)", tests: ["test/session.test.ts"] },
  { id: "gate-request-cancelled", file: "src/session.ts", find: "    signal.throwIfAborted();\n", replace: "", tests: ["test/session.test.ts"] },
  { id: "gate-release", file: "src/session.ts", find: "  } finally {\n    release();\n  }", replace: "  } finally {\n    void release;\n  }", tests: ["test/session.test.ts"] },
  { id: "gate-native-lease", file: "src/wire.ts", find: "const release = await deps.gate.acquire(signal());", replace: "const release = (): void => undefined;", tests: WIRE },
  { id: "gate-native-release", file: "src/wire.ts", find: "  } finally {\n    release();\n  }", replace: "  } finally {\n    void release;\n  }", tests: WIRE },
  { id: "errno-emscripten", file: "src/vm-fs.ts", find: "{ code: this.#ports.errno.toEmscripten(linuxErrno) }", replace: "{ code: linuxErrno }", tests: FS },
  { id: "errno-enoent-in-flush", file: "src/vm-fs.ts", find: "const EIO = 5, ENOENT = 2,", replace: "const EIO = 5, ENOENT = 3,", tests: FS },
  { id: "errno-eexist-in-mkdir", file: "src/vm-fs.ts", find: "EBADF = 9, EEXIST = 17;", replace: "EBADF = 9, EEXIST = 18;", tests: FS },
  { id: "errno-bad-descriptor", file: "src/vm-fs.ts", find: 'throw this.#failure("Bad database descriptor", EBADF);', replace: 'throw this.#failure("Bad database descriptor", EIO);', tests: FS },
  { id: "path-dot-dot", file: "src/vm-fs.ts", find: 'part === "." || part === ".." || part.includes("\\0")', replace: 'part === "." || part.includes("\\0")', tests: FS },
  { id: "path-dot", file: "src/vm-fs.ts", find: 'part === "." || part === ".." ||', replace: 'part === ".." ||', tests: FS },
  { id: "path-nul", file: "src/vm-fs.ts", find: ' || part.includes("\\0")', replace: "", tests: FS },
  { id: "path-empty-segments", file: "src/vm-fs.ts", find: 'const parts = path.split("/").filter(part => part !== "");', replace: 'const parts = path.split("/");', tests: FS },
  { id: "path-root", file: "src/vm-fs.ts", find: 'return parts.length === 0 ? this.#root : `${this.#root}/${parts.join("/")}`;', replace: 'return `${this.#root}/${parts.join("/")}`;', tests: FS },
  { id: "fs-truncate-flag", file: "src/vm-fs.ts", find: '["w", O_WRONLY | O_CREAT | O_TRUNC],', replace: '["w", O_WRONLY | O_CREAT],', tests: FS },
  { id: "fs-exclusive-flag", file: "src/vm-fs.ts", find: '["wx", O_WRONLY | O_CREAT | O_TRUNC | O_EXCL],', replace: '["wx", O_WRONLY | O_CREAT | O_TRUNC],', tests: FS },
  { id: "fs-flush-order", file: "src/vm-fs.ts", find: "right.length - left.length", replace: "left.length - right.length", tests: FS },
  { id: "fs-flush-forgets", file: "src/vm-fs.ts", find: "    this.#dirty.clear();\n", replace: "", tests: FS },
  { id: "fs-read-cap", file: "src/vm-fs.ts", find: "this.#ports.files.read(descriptor, Math.min(length, MAX_IO_BYTES))", replace: "this.#ports.files.read(descriptor, length)", tests: FS },
  { id: "fs-write-cap", file: "src/vm-fs.ts", find: "offset + Math.min(length, MAX_IO_BYTES)", replace: "offset + length", tests: FS },
  { id: "fs-chmod-bits", file: "src/vm-fs.ts", find: "this.#ports.files.chmod(target, mode & PERMISSION_BITS)", replace: "this.#ports.files.chmod(target, mode)", tests: FS },
  { id: "fs-truncate-length", file: "src/vm-fs.ts", find: "!Number.isSafeInteger(length) || length < 0", replace: "length < 0", tests: FS },
  { id: "fs-rename-follows", file: "src/vm-fs.ts", find: "if (item.path === from) item.path = to;", replace: "", tests: FS },
  { id: "wire-copy-handshake-flush", file: "src/wire.ts", find: "  sink.flushSync();\n  sink.reset();", replace: "  sink.reset();", tests: [...WIRE, "test/adapter.test.ts"] },
  { id: "wire-response-flush", file: "src/wire.ts", find: 'if (framer.truncated) throw new Error("Truncated PostgreSQL backend response");\n  await sink.flush(signal());', replace: 'if (framer.truncated) throw new Error("Truncated PostgreSQL backend response");', tests: [...WIRE, "test/adapter.test.ts"] },
  { id: "adapter-copy-socket", file: "module.ts", find: "host.fs.read(connection.fd, maxBytes)", replace: "host.fs.read(0, maxBytes)", tests: ["test/adapter.test.ts"] },
  { id: "adapter-requires-spawn", file: "module.ts", find: 'host: ["files.sync", "process.info"]', replace: 'host: ["files.sync", "process.info", "process.spawn"]', tests: ["test/adapter.test.ts", "test/module.test.ts"] },
  { id: "adapter-spawns", file: "module.ts", find: "const { pid } = await host.process.info();", replace: 'const { pid } = await host.process.info(); void Reflect.get(host.process, "spawn");', tests: ["test/adapter.test.ts"] },
  { id: "sink-nosignal", file: "src/client-sink.ts", find: "ports.fs.writeAll(ports.connection.fd, bytes, { noSignal: true });", replace: "ports.fs.writeAll(ports.connection.fd, bytes);", tests: ["test/client-sink.test.ts"] },
  { id: "sink-threshold", file: "src/client-sink.ts", find: "export const STREAM_THRESHOLD = 1024 ** 2;", replace: "export const STREAM_THRESHOLD = 2 * 1024 ** 2;", tests: ["test/client-sink.test.ts"] },
  { id: "sink-threshold-comparison", file: "src/client-sink.ts", find: "if (pendingBytes >= threshold) sendNow();", replace: "if (pendingBytes > threshold) sendNow();", tests: ["test/client-sink.test.ts"] },
  { id: "sink-copies-bytes", file: "src/client-sink.ts", find: "pending.push(bytes.slice());", replace: "pending.push(bytes);", tests: ["test/client-sink.test.ts"] },
  { id: "sink-reset", file: "src/client-sink.ts", find: "    reset() {\n      pending = [];\n      pendingBytes = 0;\n    },", replace: "    reset() {\n      void pending;\n    },", tests: ["test/client-sink.test.ts"] },
  { id: "sink-abort-reason", file: "src/client-sink.ts", find: "if (signal.aborted) throw error;", replace: "", tests: ["test/client-sink.test.ts"] },
  { id: "sink-concat", file: "src/bytes.ts", find: "return concat(parts);", replace: "return concat(parts.slice(1));", tests: ["test/bytes.test.ts"] },
  { id: "fs-utimes-follows-links", file: "src/vm-fs.ts", find: "{ followLinks: true }", replace: "{ followLinks: false }", tests: FS },
  { id: "fs-utimes-validation", file: "src/vm-fs.ts", find: "if (Number.isNaN(accessed.getTime()) || Number.isNaN(modified.getTime())) throw", replace: "if (Number.isNaN(accessed.getTime())) throw", tests: FS },
  { id: "fs-utimes-new-date", file: "src/vm-fs.ts", find: "const accessed = new Date(atime), modified = new Date(mtime);", replace: "const accessed = new Date(atime), modified = new Date(atime);", tests: FS },
  { id: "storage-verification", file: "src/storage.ts", find: "exported !== undefined && exported.fingerprint !== verified", replace: "false", tests: ["test/storage.test.ts"] },
  { id: "storage-staging-strict", file: "src/storage.ts", find: "    relaxedDurability: false,\n    fs: filesystem(host, directory),", replace: "    fs: filesystem(host, directory),", tests: ["test/storage.test.ts"] },
  { id: "storage-marker-flush", file: "src/storage.ts", find: '  host.kit.directory.sync(host.files, markerPath, "file");\n', replace: "", tests: ["test/storage.test.ts"] },
  { id: "storage-archive-limit", file: "src/storage.ts", find: "exported.archive.size > MAX_ARCHIVE_BYTES", replace: "exported.archive.size >= MAX_ARCHIVE_BYTES", tests: ["test/storage.test.ts"] },
  { id: "fingerprint-bigint", file: "src/fingerprint.ts", find: 'typeof value === "bigint" ? value.toString() : value', replace: "value", tests: ["test/fingerprint.test.ts"] },
  { id: "sql-escape-strings", file: "src/sql-text.ts", find: 'if (word.toUpperCase() === "E" && sql.charAt(end) === "\'")', replace: "if (false)", tests: ["test/sql-text.test.ts"] },
  { id: "sql-dollar-quotes", file: "src/sql-text.ts", find: 'char === "$"', replace: 'char === "#"', tests: ["test/sql-text.test.ts"] },
  { id: "guest-files-skip-identical", file: "src/guest-files.ts", find: "if (sameContent(host, file.to, bytes)) {", replace: "if (false) {", tests: ["test/guest-files.test.ts"] },
  { id: "options-workspace", file: "src/options.ts", find: "if (!value.startsWith(`${WORKSPACE}/`)) throw refusal;", replace: "", tests: ["test/options.test.ts"] },
];

async function main(prefix: string): Promise<number> {
  const selected = MUTATIONS.filter(mutation => mutation.id.startsWith(prefix));
  const files = [...new Set(selected.map(mutation => mutation.file))];
  const dirty = execFileSync("git", ["status", "--porcelain", "--", ...files], { cwd: root, encoding: "utf8" });
  if (dirty.trim() !== "") throw new Error(`Commit or stash first; these files differ from HEAD:\n${dirty}`);
  const survivors: string[] = [];
  for (const mutation of selected) {
    const path = join(root, mutation.file);
    const original = await readFile(path, "utf8");
    if (original.split(mutation.find).length !== 2) throw new Error(`${mutation.id}: the text to change must occur exactly once in ${mutation.file}`);
    await writeFile(path, original.replace(mutation.find, () => mutation.replace));
    try {
      const outcome = await execute(join(root, "node_modules/.bin/vitest"), ["run", ...mutation.tests, "--bail=1", "--testTimeout=60000"], { cwd: root, timeout: 240_000, maxBuffer: 16 * 1024 ** 2 }).then(
        () => "survived",
        (error: unknown) => `killed by ${error instanceof Error && "stdout" in error ? /FAIL\s+(\S+) > ([^\n]+)/u.exec(`${String(error.stdout)}\n${"stderr" in error ? String(error.stderr) : ""}`)?.slice(1).join(" > ") ?? "a failing run" : "a failing run"}`,
      );
      process.stdout.write(`${outcome.startsWith("survived") ? "SURVIVED" : "killed  "}  ${mutation.id}${outcome.startsWith("survived") ? "" : `  (${outcome.slice(10)})`}\n`);
      if (outcome.startsWith("survived")) survivors.push(mutation.id);
    } finally {
      await writeFile(path, original);
    }
  }
  process.stdout.write(`\n${String(selected.length - survivors.length)} of ${String(selected.length)} mutations were caught${survivors.length === 0 ? "" : `; survived: ${survivors.join(", ")}`}\n`);
  return survivors.length === 0 ? 0 : 1;
}

if (import.meta.main) process.exitCode = await main(process.argv[2] ?? "");
