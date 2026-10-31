/** Big-endian integers and byte joins, shared by the JSON endpoint's length prefix and the PostgreSQL wire protocol. */

/** Four bytes, most significant first. */
export function int32(value: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value);
  return bytes;
}

/** The unsigned integer in the first four bytes of a view; throws a RangeError when there are fewer. */
export function number32(bytes: Uint8Array): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
}

/** One new array holding the parts one after another. */
export function concat(parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
}

/** The same, for a few parts that are at hand (a long list goes to `concat`, which has no argument limit). */
export function join(...parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  return concat(parts);
}
