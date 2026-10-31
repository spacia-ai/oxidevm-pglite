import type { Connection, Host, Kit } from "@oxidevm/sdk/wasm";

/**
 * The host operations the leaf modules use, named after the capability that provides them. They are derived
 * from the SDK's `Host` type so that nothing here imports a value from the SDK (an adapter ships as one file).
 */
export type SyncFiles = Host<"files.sync">["fs"];
export type AsyncFiles = Host<"files.async">["files"];
export type NativeProcesses = Host<"process.spawn">["process"];
export type Descriptor = Connection["fd"];
export type { Connection, Kit };

/** The parts of the SDK kit that the leaf modules take, so that a test passes the real kit or a narrower one. */
export type KitErrno = Kit["errno"];
export type KitFraming = Kit["framing"];
export type KitDirectory = Kit["directory"];
