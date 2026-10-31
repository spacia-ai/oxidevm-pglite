# pglite: instructions for coding agents

This repository is an OxideVM WebAssembly module. `module.ts` holds the whole definition: a literal `manifest` and the `adapter` that runs the WebAssembly inside a Userspace JS process.

- Edit `module.ts`, `src/` and `test/`. Never edit `dist/`; `pnpm run build` writes it.
- Keep the manifest a literal. The build reads it without running code, so it cannot call functions or use variables.
- Declare in `requires.host` only what the adapter uses. The adapter's `host` has exactly those members, and the type checker enforces it.
- Import types from `@oxidevm/sdk/wasm` with `import type`; the only value import is `defineModule`. The adapter ships as one self-contained file.
- No `any`, no `@ts-ignore`, no non-null assertions. Treat everything from outside (arguments, bytes, WebAssembly exports) as `unknown` and check it.
- Artifacts are files in this repository named by `from`. Pin upstream binaries by hash where they come from, and keep their licenses and notices in this repository.
- Verify with `pnpm run check` (types, lint, and `oxidevm wasm build --check`), then `pnpm test`.
- Release by tag: `pnpm run release` prints the steps.
