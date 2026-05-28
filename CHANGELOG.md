# Changelog

## 0.1.0

- Initial release of `@anentrypoint/sandbox`: a self-contained, in-browser x86_64 Linux sandbox SDK backed by the webix/Blink WASM emulator. Derived from `@vercel/sandbox` (Apache-2.0) with the remote backend removed.
- Runs real ELF binaries in the browser or Node; `runCommand`/`writeFiles`/`readFile`/`mkDir`/`snapshot` over an in-memory Alpine rootfs. No network, no credentials.
- Live browser demo + CI that builds, version-bumps, deploys GitHub Pages, and (with `NPM_TOKEN`) publishes to npm.
