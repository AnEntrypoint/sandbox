# NOTICE

`@anentrypoint/sandbox` is a self-contained, in-browser sandbox SDK.

## Derivation

The SDK surface (`Sandbox`, `Session`, `Command`, `Snapshot`, `FileSystem`) is
derived from **Vercel Sandbox** (`@vercel/sandbox`), Copyright Vercel, Inc.,
licensed under the Apache License, Version 2.0. This project retains that
license (see `LICENSE`) and has been substantially modified: the remote
Firecracker/HTTP backend has been removed and replaced with a self-contained
in-browser x86_64 Linux backend. No network calls are made to Vercel.

## Bundled / required components

- **webix** (https://github.com/AnEntrypoint/webix) — the Blink-backed x86_64
  Linux userspace emulator that executes commands. MIT licensed. Pulled as a
  runtime dependency; its `blinkenlib.wasm` is upstream **Blink**
  (https://github.com/jart/blink), ISC licensed.
- **zod** (MIT), **ms** (MIT) — runtime dependencies.

Modifications are licensed under Apache-2.0 as part of this project.
