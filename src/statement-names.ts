/**
 * Prepared-statement names of the extended protocol, made private to one connection. Every native connection
 * shares PostgreSQL's one backend, and with it one namespace of prepared statements, where two drivers that both
 * call their statement `S_1`, or both use the unnamed one, would run each other's SQL. So the name in Parse,
 * Bind, Describe and Close is prefixed with the connection's own prefix before PostgreSQL sees it. The unnamed
 * statement becomes the statement named by the prefix alone.
 */

const PARSE = 80, BIND = 66, DESCRIBE = 68, CLOSE = 67, STATEMENT = 83;

export interface ScopedMessage {
  readonly body: Uint8Array;
  /** The scoped name of the statement the message defines (Parse) or removes (Close), when it does. */
  readonly defines?: Uint8Array;
  readonly removes?: Uint8Array;
  /** True when the message defines the unnamed statement, which replaces the one before it. */
  readonly unnamed?: boolean;
}

/** The message body with `prefix` put before the statement name that starts at `start`; unchanged when the name does not end. */
function prefixed(body: Uint8Array, start: number, prefix: Uint8Array): { readonly body: Uint8Array; readonly name: Uint8Array; readonly empty: boolean } | undefined {
  const end = body.indexOf(0, start);
  if (start < 0 || start > body.length || end < 0) return undefined;
  const scoped = new Uint8Array(body.length + prefix.length);
  scoped.set(body.subarray(0, start));
  scoped.set(prefix, start);
  scoped.set(body.subarray(start), start + prefix.length);
  return { body: scoped, name: scoped.slice(start, end + prefix.length), empty: end === start };
}

/** Rewrites the statement name in the body of one frontend message of type `type`. Other messages, and malformed ones, pass unchanged. */
export function scopeStatementName(type: number, body: Uint8Array, prefix: Uint8Array): ScopedMessage {
  if (type === PARSE) {
    const scoped = prefixed(body, 0, prefix);
    return scoped === undefined ? { body } : { body: scoped.body, defines: scoped.name, unnamed: scoped.empty };
  }
  if (type === BIND) {
    // The portal's name comes first; portals end with their transaction and are never shared.
    const portalEnd = body.indexOf(0);
    return portalEnd < 0 ? { body } : { body: prefixed(body, portalEnd + 1, prefix)?.body ?? body };
  }
  if ((type === DESCRIBE || type === CLOSE) && body[0] === STATEMENT) {
    const scoped = prefixed(body, 1, prefix);
    if (scoped === undefined) return { body };
    return type === CLOSE ? { body: scoped.body, removes: scoped.name } : { body: scoped.body };
  }
  return { body };
}
