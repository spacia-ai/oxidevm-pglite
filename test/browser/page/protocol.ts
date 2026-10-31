/** What the Node-side harness hands the page, and what the page hands back. Plain JSON, nothing else crosses. */

export interface ImageReference {
  readonly manifestUrl: string;
  readonly manifestSHA256: string;
  readonly trust: { readonly algorithm: "Ed25519"; readonly keyId: string; readonly publicKey: string };
}

export interface SuiteConfig {
  readonly suite: string;
  /** Only the scenarios whose name contains this text run (and the "start:" ones they depend on); empty runs all. */
  readonly only: string;
  readonly origin: string;
  readonly image: ImageReference;
  /** The tarball with native psql and psycopg for the guest. */
  readonly clientsURL: string;
  /** Where the page can fetch the PGlite files it needs to build a legacy IndexedDB database. */
  readonly legacyURLs: { readonly wasm: string; readonly initdb: string; readonly data: string };
}

export interface ScenarioResult {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}
