# oxidevm-pglite: instructions for coding agents

This repository is an OxideVM WebAssembly module: PGlite (PostgreSQL for WebAssembly) as a Userspace service. `module.ts` holds the literal `manifest` and the wiring of the `adapter`; the behavior lives in leaf modules in `src/`.

- Edit `module.ts`, `src/`, `guest/` (the Python client), `test/` and `scripts/`. Never edit `dist/` (`pnpm run build` writes it) or the mirrored files in `upstream/` (`node scripts/fetch-upstream.ts` writes them; `upstream/lock.json` is what pins them).
- Keep the manifest a literal. The build reads it without running code. When a value in it is also used by the adapter (paths, guest files), it is repeated in `src/layout.ts` and `test/module.test.ts` fails when the two differ.
- Declare in `requires.host` only what the adapter uses. The adapter's `host` has exactly those members, and the type checker enforces it.
- Import types from `@oxidevm/sdk/wasm` with `import type`; the only value import is `defineModule`. The adapter ships as one self-contained file: use `host.kit` (errno mapping, framing, gate, atomic directories) rather than rewriting it.
- No `any`, no `@ts-ignore`, no non-null assertions, no unsafe type assertions. Values from outside (sockets, pipes, files, JSON) arrive as `unknown` and are decoded with exact keys (`src/decode.ts`).
- Leaf modules take their host operations as narrow parameters, so that tests use real PGlite on a directory of this machine (`test/support/node-files.ts`) instead of mocks of PGlite.
- The module starts no program of the image: PostgreSQL's responses are written with `connection.write` (and, where the event loop cannot wait, `host.fs.writeAll(..., { noSignal: true })`, see `src/client-sink.ts`), file times with `host.fs.utimes`. `test/adapter.test.ts` fails if the adapter reaches for `process.spawn`; keep `process.info` as the only process capability.
- Verify with `pnpm run check` (types, lint, and `oxidevm wasm build --check`), then `pnpm test`; `pnpm run mutate` checks that the tests would notice a changed limit, path check, errno or byte order. The real-engine tests (`pnpm test:browser`) need a Userspace image and a Chromium; see the README.
- Release by tag: `pnpm run release` prints the steps.
