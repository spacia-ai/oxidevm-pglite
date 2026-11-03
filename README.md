# oxidevm-pglite

PostgreSQL in your OxideVM workspace. This [OxideVM](https://oxidevm.dev) WebAssembly module runs
[PGlite](https://pglite.dev) (PostgreSQL 18 compiled to WebAssembly) as a service of a Userspace VM. The database is a
directory of ordinary files in the workspace, and the service shares the VM's process ids and sockets, so real Linux
programs reach it:

- **`sql`**: a JSON protocol (`oxidevm-sql/1`) on the Unix socket `/workspace/_oxidevm/pglite.sock`, with a small Python client;
- **`pg`**: the PostgreSQL wire protocol on `127.0.0.1:5432`, for `psql`, psycopg, `pg_dump` and any other driver.

It is the reusable form of the database service in the OxideVM sample (`ed4984d`): same behavior, as a module you install
with one command instead of code you copy. It asks the host for two things only: file operations and its own process id.
It starts no program of the image, and it uses no browser storage: no IndexedDB, no Web Locks, no OPFS of its own.

## Use it

```sh
oxidevm wasm add github:spacia-ai/oxidevm-pglite@v0.2.0
```

The command shows what the module declares and asks before it installs anything. It needs a cross-origin isolated page
(see the [module documentation](https://oxidevm.dev/docs)) and `@oxidevm/sdk` 0.0.12 or later, whose module frame (engine
ADR 0028) runs it. A self-hosted runtime serves that frame at `<runtime.baseUrl>module-frame/` with the headers of the
SDK's `frame.json`. Version 0.1.0 does not start on 0.0.12; see [Changes in 0.2.0](#changes-in-020).

```ts
import { spawnModule, stopModule } from "@oxidevm/sdk/wasm";
import { pglite } from "./oxidevm.modules.generated";

// A service: it listens until it is stopped, and says where.
const database = await spawnModule(vm, pglite, { workspaceId: "project-1" });
console.log(database.info); // { version: "18.6", backend: "pglite-wasm", dataDir: "/workspace/pgdata", durability: "strict" }
// ... run Linux programs in the VM that use it ...
await stopModule(database); // drains, flushes the database, removes the socket, exits 0
```

`workspaceId` is required: the service is exclusive per workspace (`process.exclusive: "workspace"`), so a second start
in the same workspace (another tab, another call) fails with `wasm-module-busy` instead of corrupting the database. The
VM holds that lease for the module, from before the process starts until it ends; the module itself takes no lock.

From Python in the VM:

```python
import sys
sys.path.insert(0, "/workspace/_oxidevm")   # the module writes oxidevm_pglite.py here
import oxidevm_pglite as pg

pg.query("CREATE TABLE people (id integer PRIMARY KEY, name text)")
pg.query("INSERT INTO people VALUES ($1, $2)", [1, "Ada"])
pg.query("SELECT * FROM people")["rows"]    # [{'id': 1, 'name': 'Ada'}]
```

`query()` raises `pg.PGliteError` (a `RuntimeError`) when the statement fails. Under Pyodide it connects through the
bridge the `oxidevm-pyodide` module provides (`oxidevm.connect_unix(path)`, a blocking socket-like object with
`sendall`, `recv` and `close`); with a Linux Python it uses the `socket` module. It detects which at import.

From a shell or any driver (user `postgres`, database `postgres`, no password, no TLS):

```sh
psql "postgresql://postgres@127.0.0.1:5432/postgres?sslmode=disable"
```

## Network

This module declares no network reach: it opens no connections of its own and its `fetch` fails with "network not
declared". A service still serves programs in the VM through `expose`: the Unix socket `/workspace/_oxidevm/pglite.sock`
and `127.0.0.1:5432`, which the runner binds and listens on for it. Nothing connects to the internet, so it works the same
offline, and no host is disclosed.

## One backend

PGlite has one PostgreSQL backend. A native connection therefore **leases the whole database for as long as it is
connected**: other native connections wait for it (up to five minutes, the idle limit), and a JSON request waits 250 ms
and is then answered with `A native PostgreSQL connection owns the database. Close it before using oxidevm.query().`
When the connection ends (cleanly or not) the backend is restored (`ROLLBACK`, `DISCARD ALL`) before the next client
gets it, so settings, prepared statements and transactions cannot leak. A native session cannot start while a JSON
client has left a transaction open (`BEGIN` without `COMMIT`); the JSON client sees that transaction survive.

## The JSON endpoint (`oxidevm-sql/1`)

One request per connection. Both directions are a 4-byte big-endian length followed by that many bytes of JSON.

```text
request  {"sql": "SELECT $1::int + 1 AS next", "params": [41]}        exactly these two keys, at most 1024 parameters
reply    {"ok": true, "result": {"rows": [{"next": 42}], "fields": [{"name": "next", "dataTypeID": 23}],
          "affectedRows": 0, "command": "SELECT", "rowCount": 1, "pid": 1234, "backend": "pglite-wasm"}}
         {"ok": false, "error": "relation \"t\" does not exist"}
```

| Limit | Value |
| --- | --- |
| request | 64 KiB (`Database request exceeds 64 KiB`; the body is not read) |
| reply | 1 MiB (`Database response exceeds 1 MiB. Use LIMIT or select fewer columns.`) |
| one request, from first byte to last | 30 seconds; after that nothing is answered and the connection is closed |
| wait for a native connection | 250 ms |
| `COPY` | refused (`COPY is unavailable through this experimental SQL bridge`): use port 5432 |

64-bit integers (`bigint`) arrive as strings, because JSON cannot hold them, and an integer above 2^53 in `params` loses
precision when the request is parsed (JavaScript reads JSON numbers as doubles): send it as a string (`"9223372036854775807"`)
and let PostgreSQL convert it. A client that hangs up before it has sent a whole request gets no reply, and one that hangs
up before it has read its reply costs only its own connection: the runner writes every reply so that a closed peer rejects
that write (`EPIPE`) instead of ending the module.

## The PostgreSQL endpoint (`postgres-3.0`)

Protocol 3.0 only: simple and extended queries, prepared statements, binary results, `COPY` in both directions (text and
binary), `pg_dump`. SSL and GSS-encryption requests are declined (`N`), cancel requests are accepted and ignored (there is
no second backend to signal). Frontend messages are limited to 16 MiB and one `COPY FROM STDIN` exchange to 64 MiB. At most
four clients at once (`limits.clients`): a fifth connection is closed at once.

A response is collected while a statement runs and written with the connection's own `write` when it is done. Two moments
cannot wait for the event loop and write synchronously with `noSignal` (a closed peer answers `EPIPE`, never SIGPIPE): a
response that has grown to 1 MiB is sent as it grows, so that a large result never fills memory, and the `COPY FROM STDIN`
handshake, where PostgreSQL needs the client's data before it can return. A client that vanishes in the middle of a result
therefore ends its own session and nothing else.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `dataDir` | `/workspace/pgdata` | where the database lives: an absolute path inside `/workspace`, outside `/workspace/_oxidevm` |
| `durability` | `strict` | `strict`: a statement is answered after its changes are flushed (file contents first, then their directories). `relaxed`: it is answered first and flushed right after; a failed flush is logged and reported to the next change |
| `importArchive` | empty | a PGlite data-directory archive (`dumpDataDir`, plain or gzip) to load when the data directory is created: one file, or a directory whose regular files, in name order, are its consecutive pieces (at most 64); an absolute path inside `/workspace`, outside `dataDir`; empty means a new, empty database. See [Migrate from IndexedDB](#migrate-from-indexeddb) |

## Safe by construction

- **Atomic creation.** A new database is built in `/workspace/_oxidevm/pgdata-migrating`, verified, marked
  (`.oxidevm-storage.json`, with a fingerprint of its schema and rows) and flushed, and only then renamed to `dataDir`; the
  parent directories are flushed after the rename. A crash leaves either no database or a whole one; an earlier unfinished
  attempt is kept aside as `pgdata-migrating-failed-<uuid>`. A `dataDir` that exists without the marker is refused, not
  adopted.
- **Import.** With `importArchive`, a new database is loaded from that archive in the staging directory, and only a whole,
  marked copy is renamed into place. The marker records `source: "archive"`, the archive's path and the fingerprint of
  the copy (tables, columns, constraints, sequences, views, a digest of every row). The archive is never changed or
  removed and is limited to 256 MiB in all. A missing, oversized or unreadable archive fails the start and leaves no data
  directory, instead of starting an empty database. Once the data directory exists the option is ignored.
- **Durability.** Every statement's changes are made durable in the VM file system in a fixed order (changed files, then the
  directories that hold them, deepest first); a failed flush fails the statement. File times that PostgreSQL's file system
  layer restores (for example when a data directory is loaded) reach the host's `utimes` as dates to the millisecond.

## What changed from the sample

Same behavior (JSON reply shapes, limits and messages, the wire endpoint, crash safety, the one-time migration, the
four-client cap), different structure: the database lives behind `host.kit` (errno mapping, framing, FIFO gate, atomic
directory creation) instead of hand-written copies; `chmod`, `truncate` and `utimes` are native, and PostgreSQL's responses are
written with the connection, so the sample's two Python helper processes (one for `utimes`, one that wrote responses to
avoid SIGPIPE) are gone, and with them the module's need for `process.spawn` and for a Python in the image. The Python client
is a pinned artifact the manifest declares as a `guestFile`; the runner does not write those yet, so the adapter also writes
it, atomically and only when it differs. Deliberate differences:

- A request must be exactly `{ sql, params }` (the sample ignored other keys).
- A backslash escapes only inside `E'...'` constants when the module decides whether a statement is `COPY`, as PostgreSQL does
  with `standard_conforming_strings` on; the sample treated it as an escape everywhere, so `SELECT '\'; COPY t FROM STDIN` was
  not recognized as `COPY`.
- The migration fingerprint no longer fails on a database with a `bigint` sequence limit (`bigserial`, identity columns,
  `CREATE SEQUENCE`): the sample's `JSON.stringify` threw on `bigint`.
- A relaxed flush that fails is reported instead of becoming an unhandled rejection.
- A client that goes away before sending a whole JSON request gets no reply (the sample tried to write one).
- The one-time migration from IndexedDB happens in the page, not in the module (see below): module code runs where there
  is no IndexedDB.

## Migrate from IndexedDB

The module runs in the VM's module frame, an opaque origin without IndexedDB, so it cannot open a database that an earlier
PGlite application kept in IndexedDB (`idb://<name>`). The page can: export the database there once, write the archive into
the workspace, and start the module with `importArchive`. PGlite and the SDK APIs used here are public; nothing else is
needed.

```ts
import { PGlite } from "@electric-sql/pglite";
import type { UserspaceVM } from "@oxidevm/sdk";
import { spawnModule } from "@oxidevm/sdk/wasm";
import { pglite } from "./oxidevm.modules.generated";

export async function startWithLegacyData(vm: UserspaceVM, legacyName: string) {
  const known = (await indexedDB.databases()).some(database => database.name === `/pglite/${legacyName}`);
  const migrated = await vm.workspace.readText("pgdata/.oxidevm-storage.json").then(() => true, () => false);
  if (known && !migrated) {
    const legacy = await PGlite.create({ dataDir: `idb://${legacyName}` });
    try {
      const archive = new Uint8Array(await (await legacy.dumpDataDir("gzip")).arrayBuffer());
      // One workspace write takes at most 16 MiB, so the archive goes in as numbered pieces of one directory.
      await vm.workspace.createDirectory("pglite-import");
      for (let offset = 0, index = 0; offset < archive.length; offset += 16 * 1024 ** 2, index += 1) {
        await vm.workspace.writeFile(`pglite-import/${String(index).padStart(3, "0")}`, archive.subarray(offset, offset + 16 * 1024 ** 2));
      }
    } finally {
      await legacy.close();
    }
  }
  return spawnModule(vm, pglite, { workspaceId: "project-1", options: known && !migrated ? { importArchive: "/workspace/pglite-import" } : {} });
}
```

The IndexedDB database is only read, never changed or removed; delete it yourself once you have checked the workspace copy.
The `migration` browser suite runs exactly this sequence against a real engine.

## Changes in 0.2.0

0.2.0 runs on `@oxidevm/sdk` 0.0.12, whose module frame (engine ADR 0028) has no IndexedDB, no Web Locks and, in Chromium,
no `crypto.subtle` or `crypto.randomUUID`. 0.1.0 declared `requires.browser: ["indexeddb", "web-locks"]` for its built-in
migration, so 0.0.12 refuses every start of it with `wasm-module-prerequisite`.

- **No browser requirements.** `requires.browser` is gone; `requires.host` is still `files.sync` and `process.info`. The
  database was already ordinary files of the VM; single-writer safety is the VM's workspace lease (`exclusive:
  "workspace"`), which 0.0.12 takes in the Userspace worker, outside module code.
- **`legacyIndexedDb` is replaced by `importArchive`.** The module no longer opens IndexedDB. Applications that migrated a
  legacy database export it in the page and pass the archive (see [Migrate from IndexedDB](#migrate-from-indexeddb)).
  0.1.0 verified the copy against a fingerprint of the IndexedDB original; 0.2.0 cannot read the original, so it records the
  fingerprint of the copy, and the check against the original is the page's (it holds both).
- **Fingerprints and temporary names without secure-context APIs.** The fingerprint's SHA-256 is computed by PostgreSQL
  (`sha256()`), giving the same digest as before; temporary and set-aside names use `crypto.getRandomValues`.
- **Network: none**, stated in the new [Network](#network) section (engine ADR 0029).

Migration notes:

- **A data directory 0.1.0 made opens unchanged**, including one it migrated from IndexedDB (marker `source:
  "indexeddb"`); its backup archive under `/workspace/_oxidevm/` is kept. Nothing to do.
- **A legacy IndexedDB database 0.1.0 has not migrated yet** (the application never started 0.1.0 with `legacyIndexedDb`
  in that browser): either start 0.1.0 once on SDK 0.0.9 with `legacyIndexedDb` before upgrading, or export it in the page
  as shown above. 0.1.0 itself never wrote to IndexedDB.
- **Remove `legacyIndexedDb` from `spawnModule` options**: the regenerated handle no longer has it. Use `importArchive` instead.
- **Downgrade:** 0.1.0 refuses a data directory 0.2.0 imported (marker `source: "archive"` is unknown to it); a directory
  0.2.0 created empty opens in 0.1.0.

## Develop it

```sh
pnpm install
node scripts/fetch-upstream.ts   # mirrors pglite.wasm, initdb.wasm, pglite.data; checks them against upstream/lock.json
pnpm run check                   # tsc (module, tests, scripts), ESLint (strict type-checked, no warnings), the lock, oxidevm wasm build --check
pnpm test                        # unit tests: real PGlite on a directory of this machine, the Python client with python3
pnpm run build                   # writes dist/: module.json, adapter.mjs, the artifacts and SHA256SUMS
pnpm run mutate                  # mutation test of the ported logic (needs a clean tree)
pnpm run test:conformance        # oxidevm wasm test: the runner's contract, in Chromium
pnpm test:browser                # real engine + Chromium (--browser=firefox|webkit), see below
```

`@oxidevm/sdk` and `@oxidevm/cli` are exact devDependencies, installed from npm; 0.2.0 is built and tested against the
0.0.12 line. The committed `pnpm-workspace.yaml` allows
the build script of `esbuild`, and `pnpm-lock.yaml` is committed.

### Real-engine tests

`pnpm test:browser [core] [crash] [migration] [refusal] [--browser=chromium|firefox|webkit]` builds this repository's release, installs it into a fresh project with the
real CLI (`oxidevm wasm add file:…`), type-checks the page against the generated handle and bundles it with Vite, serves it
with the engine release the installed SDK pins, the SDK's module frame (with `frame.json`'s headers) and a signed Userspace
image, and drives the browser, Chromium by default (`--only=<text>` narrows
the scenarios). Without suite names, Chromium and Firefox run core, crash and migration, and WebKit runs refusal. It needs:

- `OXIDEVM_TEST_USERSPACE_IMAGE` (an image reference JSON) and `OXIDEVM_TEST_USERSPACE_IMAGE_DIR` (its bundle directory): an
  image with `/usr/bin/python3` 3.12 (the module does not need it; the test clients do);
- the engine release the installed SDK pins, in `~/.cache/oxidevm/engine/<id>` (or `OXIDEVM_ENGINE_DIR`);
- the installed SDK's module frame, served with its `frame.json` headers (`OXIDEVM_MODULE_FRAME_DIR` serves another build
  of it, such as an SDK checkout with a fix);
- `.cache/postgres-clients.tar.gz`: native `psql` 17 and psycopg 3.2.13 for musl, made by `node scripts/stage-postgres-clients.ts`
  (needs Docker) and checked against `test/postgres-clients.lock.json`. It is a test tool only: it contains libraries under
  other licenses (readline is GPL) and is never committed or released.

One fact about this engine (Userspace API 144) shaped the clients. A peer that closed cleanly answers a server's first
write normally and its second with `EPIPE`, and the write that gets `EPIPE` ends the whole process with SIGPIPE unless it
passed `noSignal`; a peer that reset the connection answers the first write with `ECONNRESET` and only then `EPIPE`.
That is why the suite has a client that closes cleanly: with `{ noSignal: true }` taken out of `src/client-sink.ts`, the
reset and killed-`psql` cases still pass and the clean close fails with `the module ended instead of failing that one
connection: signal 13`. With `@oxidevm/sdk` 0.0.7, a 30 MB `write(2)` to `/dev/null` returned 16 777 216 and `psql -A -t`
with its output on `/dev/null` failed with `could not print result table: Invalid argument`; the engine that 0.0.8 pins
accepts both whole, and the core suite checks it with `psql -o /dev/null` and 30 MB `write(2)` and `writev(2)` calls.

The suites: **core** (start and stop, the JSON reply shape, the Python client, limits, `psql`, large writes to
`/dev/null`, psycopg with prepared statements, binary, `COPY` in and out, 2 MiB and 8 MiB results, an idle connection
and a vanished client, session isolation, clients that hang up in the middle of a large result while another keeps
getting answers (one that closes cleanly right after asking for 30 MB, one that resets the connection after 64 KiB, and
the real `psql` killed while it receives a 200 MB `COPY`), JSON clients that hang up before reading their reply, the
four-client cap, a second start failing busy, a service killed with SIGKILL whose stale Unix socket the next start replaces,
answering on both the socket and the port, restart, relaxed durability),
**crash** (end the page with a transaction open: Chromium kills the renderer, Firefox and WebKit, which have no such call in
Playwright, close the page without `beforeunload`; the committed row survives, the open transaction rolls back),
**migration** (the page exports a legacy IndexedDB database into the workspace and the module imports it with `importArchive`)
and **refusal** (for WebKit, which cannot run modules: no PGlite code runs and the refusal is the SDK's typed
`FEATURE_NOT_AVAILABLE`, either at `createVM`, as in Playwright's WebKit on Linux, which has no OPFS, or at the start with
`wasm-module-isolation-unavailable` naming the missing capability, such as `blob-workers`, after which the VM stays usable).

## Release

Publishing changes what others can install, so it goes draft, verify, publish: the draft is downloaded again and checked
against its own `SHA256SUMS` before it becomes visible. The tag must name the version in `module.ts`.

```sh
git tag v0.2.0 && git push origin v0.2.0
pnpm run build
gh release create v0.2.0 dist/* --draft --verify-tag --title v0.2.0
gh release download v0.2.0 --dir verify && (cd verify && sha256sum --check SHA256SUMS)
gh release edit v0.2.0 --draft=false
```

`pnpm run release` prints these steps and runs none of them. The `release` workflow does the same in GitHub Actions, in two
jobs: a read-only one fetches the mirrored WebAssembly and builds, and a second one, which installs nothing, drafts, verifies
and publishes. The `ci` workflow runs on pushes to `main` and on pull requests, and `release` runs when a `v*` tag is pushed.
Consumers install with
`oxidevm wasm add github:spacia-ai/oxidevm-pglite@v0.2.0`.

### Build warnings

`oxidevm wasm build` prints warnings about the PGlite library it bundles. They are expected: `import.meta` and `window`
appear in PGlite's Emscripten loader on code paths a worker with explicitly supplied artifacts does not take (this module
passes the compiled WebAssembly and the file bundle itself), and so does `XMLHttpRequest`, which the module frame does not
have (the loader would use it only to download those files; this module has no network reach, see [Network](#network)); `eval` appears in two places of that loader, so a page content
security policy needs `'unsafe-eval'` unless those paths are never reached (not qualified here); `node:module` is replaced
by an empty module; and `util@unknown` is the Node `util` import that PGlite's `browser` field disables, which the build
lists because the package manager hoisted an unrelated `util` next to it. Nothing of it is in the bundle.

## Licenses

This module's code is Apache-2.0 (`LICENSE`, `NOTICE`). The release also carries, unmodified, WebAssembly and a data bundle
from the `@electric-sql/pglite@0.5.14` npm package (pinned by sha256 in `upstream/lock.json`), which contain PostgreSQL 18.6
(PostgreSQL License) and, linked or bundled with it, Emscripten's runtime, libc++abi, libxml2, ICU collation data, the
Snowball stemmers and the IANA time zone database. `NOTICES.txt` lists every component with the evidence it was found by and
carries the license texts; `license.spdx` in the manifest is
`Apache-2.0 AND PostgreSQL AND MIT AND Unicode-3.0 AND BSD-3-Clause AND Apache-2.0 WITH LLVM-exception`.
