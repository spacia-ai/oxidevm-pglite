import { exactKeys, isRecord } from "./decode.ts";

/** The file that proves a data directory was created and verified by this module. */
export const MARKER_NAME = ".oxidevm-storage.json";
export const MAX_MARKER_BYTES = 4096;

export interface StorageMarker {
  readonly version: 1;
  /** `indexeddb` when the directory was migrated from a legacy IndexedDB database. */
  readonly source: "new" | "indexeddb";
  /** The fingerprint of the database as it was verified, a SHA-256 in hex. */
  readonly fingerprint: string;
  /** The guest path of the archive of the legacy database, kept as a backup. */
  readonly backup: string | null;
}

const FINGERPRINT = /^[0-9a-f]{64}$/u;

export function encodeMarker(marker: StorageMarker): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(JSON.stringify({ version: marker.version, source: marker.source, fingerprint: marker.fingerprint, backup: marker.backup }));
}

/** Decodes a marker read from disk. A newer version is refused as unsupported, anything malformed as invalid. */
export function decodeMarker(bytes: Uint8Array): StorageMarker {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error("Unreadable VM PostgreSQL storage marker");
  }
  if (isRecord(parsed) && parsed["version"] !== undefined && parsed["version"] !== 1) throw new Error("Unsupported VM PostgreSQL storage marker");
  if (!isRecord(parsed) || !exactKeys(parsed, ["version", "source", "fingerprint", "backup"])) throw new Error("Invalid VM PostgreSQL storage marker");
  const { source, fingerprint, backup } = parsed;
  if ((source !== "new" && source !== "indexeddb") || typeof fingerprint !== "string" || !FINGERPRINT.test(fingerprint) || (backup !== null && typeof backup !== "string")) {
    throw new Error("Invalid VM PostgreSQL storage marker");
  }
  return { version: 1, source, fingerprint, backup };
}
