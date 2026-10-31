# pglite

An [OxideVM](https://oxidevm.dev) WebAssembly module (service). A service module listens on the sockets its manifest declares and serves clients until it is stopped.

## Use it

In an OxideVM application:

```sh
oxidevm wasm add github:OWNER/REPO@v0.1.0
```

The command shows what the module declares and asks before installing it.

## Develop it

```sh
pnpm install
pnpm run check   # types, lint, and the same checks the build makes
pnpm test        # unit tests of your own code
pnpm run build   # writes dist/: module.json, adapter.mjs, your artifacts and SHA256SUMS
```

`module.ts` is the whole definition. `upstream/` holds the WebAssembly files the module wraps.

## Release it

```sh
git tag v0.1.0 && git push origin v0.1.0
```

The tag must name the version in `module.ts`. The `release` workflow builds, drafts a GitHub release with every file in `dist/`, downloads it again to verify its `SHA256SUMS`, and publishes it. `pnpm run release` prints the same steps for doing it by hand.

## License

Apache-2.0 (see `LICENSE`). Change the license in `module.ts` and this repository to match the code you wrap, and keep the notices of anything you bundle.
