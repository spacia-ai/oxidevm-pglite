import { GUEST_FILES, OXIDEVM_DIRECTORY } from "./layout.ts";
import type { KitErrno, SyncFiles } from "./ports.ts";

export interface GuestFileHost {
  readonly fs: Pick<SyncFiles, "lstat" | "mkdir" | "readFile" | "writeFile" | "rename" | "chmod">;
  readonly artifacts: { bytes(name: string): Promise<Uint8Array> };
  readonly errno: KitErrno;
  /** The directory that holds the files; created when missing. */
  readonly directory?: string;
  /** A unique suffix for a temporary file. */
  readonly unique?: () => string;
}

interface GuestFile { readonly artifact: string; readonly to: string; readonly mode: number }

const ENOENT = 2, EEXIST = 17;

function sameContent(host: GuestFileHost, target: string, expected: Uint8Array): boolean {
  try {
    if (host.fs.lstat(target).size !== BigInt(expected.length)) return false;
    const actual = host.fs.readFile(target, expected.length);
    return actual.length === expected.length && actual.every((byte, index) => byte === expected[index]);
  } catch (error: unknown) {
    if (host.errno.of(error) === ENOENT) return false;
    throw error;
  }
}

/**
 * Makes sure the Python client is in the guest, byte for byte as the release pins it.
 * The manifest declares them as `guestFiles`; the engine's module runner does not write those yet, so the
 * adapter does, atomically (a temporary file renamed into place) and only when something differs.
 */
export async function ensureGuestFiles(host: GuestFileHost, files: readonly GuestFile[] = GUEST_FILES): Promise<void> {
  try {
    host.fs.mkdir(host.directory ?? OXIDEVM_DIRECTORY, 0o755);
  } catch (error: unknown) {
    if (host.errno.of(error) !== EEXIST) throw error;
  }
  for (const file of files) {
    const bytes = await host.artifacts.bytes(file.artifact);
    if (sameContent(host, file.to, bytes)) {
      host.fs.chmod(file.to, file.mode);
      continue;
    }
    const temporary = `${file.to}.tmp-${(host.unique ?? (() => crypto.randomUUID()))()}`;
    host.fs.writeFile(temporary, bytes);
    host.fs.chmod(temporary, file.mode);
    host.fs.rename(temporary, file.to);
  }
}
