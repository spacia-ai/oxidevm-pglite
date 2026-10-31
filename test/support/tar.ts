export interface TarEntry {
  readonly name: string;
  readonly size: number;
  /** Seconds since the epoch, as the header holds them. */
  readonly mtime: number;
  /** `file` for a regular file, `directory`, or `other`. */
  readonly kind: "file" | "directory" | "other";
}

/** The entries of an uncompressed ustar archive: enough of the format to read what PGlite's `dumpDataDir` writes. */
export function tarEntries(bytes: Uint8Array): TarEntry[] {
  const decoder = new TextDecoder(), entries: TarEntry[] = [];
  let offset = 0;
  while (offset + 512 <= bytes.length) {
    const field = (start: number, end: number): string => decoder.decode(bytes.subarray(offset + start, offset + end)).replace(/\0[\s\S]*$/u, "");
    const name = field(0, 100);
    if (name === "") break;
    const size = Number.parseInt(field(124, 136).trim() || "0", 8), mtime = Number.parseInt(field(136, 148).trim() || "0", 8), type = field(156, 157);
    entries.push({ name, size, mtime, kind: type === "0" || type === "" ? "file" : type === "5" ? "directory" : "other" });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}
