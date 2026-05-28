# Agents

`@anentrypoint/sandbox` is a self-contained, in-browser x86_64 Linux sandbox SDK.
Commands run as real ELF binaries inside a WASM module (the
[webix](https://github.com/AnEntrypoint/webix) Blink emulator) — there is no
server, no network, and no remote backend.

## Architecture

- `src/api-client/webix-client.ts` — `WebixApiClient` implements the SDK's
  client surface over a local Blink host (no HTTP).
- `src/webix/host.ts` — `WebixHost` boots the Blink WASM (browser vs Node),
  mounts the rootfs, preloads busybox, and serializes runs.
- `src/sandbox.ts` / `session.ts` / `snapshot.ts` / `command.ts` — the public
  `Sandbox` API, constructing `WebixApiClient` (no credentials).

## Rules

- `webix` is a GitHub dependency (`github:AnEntrypoint/webix`), not the npm
  package named `webix` (that is an unrelated UI library). Its npm `files`
  whitelist omits the rootfs tarball, so the rootfs is fetched from the webix
  repo's raw URL — keep defaults pointing there.
- No networking: the Blink build is `NOSOCK`. `domain()`, ports, dev servers,
  and `updateNetworkPolicy` throw `NotSupportedError`. There is no remote
  registry, so `Sandbox.get/getOrCreate/fork/list` and `Snapshot.get/list/tree`
  throw too. Do not reintroduce remote/HTTP paths.
- `browser-demo/` ships only `index.html`, `serve.mjs`, and `build-demo.mjs`;
  the `dist/`, `webix/`, `containers/`, `vendor/` subdirs are assembled by
  `npm run build:demo` and gitignored. Never commit the WASM/rootfs blobs.
- This is derived from `@vercel/sandbox` (Apache-2.0); keep `LICENSE` and
  `NOTICE.md`. CI auto-bumps the patch version on every push to `main` and
  guards its own commit with `[skip ci]`.
