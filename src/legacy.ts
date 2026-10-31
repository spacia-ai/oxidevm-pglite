import { PGlite } from "@electric-sql/pglite";
import type { PGliteOptions } from "@electric-sql/pglite";
import { fingerprint } from "./fingerprint.ts";
import type { LegacySource } from "./storage.ts";

/** PGlite names the IndexedDB database of `idb://<name>` this way. */
const databaseName = (name: string): string => `/pglite/${name}`;

/**
 * The legacy PGlite database of an earlier application, kept in the browser's IndexedDB under `name`. It is
 * opened read-only in effect: exported and fingerprinted, never changed, so it remains if a migration fails.
 */
export function indexedDbSource(name: string, pglite: PGliteOptions): LegacySource {
  return {
    async export() {
      if (typeof indexedDB.databases !== "function") throw new Error("Database migration requires IndexedDB database enumeration in this browser");
      if (!(await indexedDB.databases()).some(database => database.name === databaseName(name))) return undefined;
      const source = await PGlite.create({ ...pglite, dataDir: `idb://${name}`, relaxedDurability: false });
      try {
        return { fingerprint: await fingerprint(source), archive: await source.dumpDataDir("none") };
      } finally {
        await source.close();
      }
    },
  };
}
