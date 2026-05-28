/**
 * Assemble the static browser-demo from the build output + the webix dependency.
 * Reproducible in CI and locally — the copied dirs (dist/, webix/, containers/,
 * vendor/) are gitignored; only index.html, serve.mjs, and this script are
 * tracked. Run `npm run build` first so dist/ exists.
 */
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const require = createRequire(import.meta.url);

const ROOTFS_URL =
  "https://raw.githubusercontent.com/AnEntrypoint/webix/main/containers/alpine-minirootfs-x86_64.tar.gz";

async function main() {
  const dist = join(root, "dist");
  if (!existsSync(dist)) throw new Error("dist/ missing — run `npm run build` first");

  // Resolve the webix install root via a known subpath export (its exports map
  // does not expose ./package.json). blink-core sits at <root>/src/blink-core.js.
  const webixRoot = resolve(dirname(require.resolve("webix/blink-core")), "..");

  // SDK build output
  await rm(join(here, "dist"), { recursive: true, force: true });
  await cp(dist, join(here, "dist"), { recursive: true });

  // webix browser modules
  await rm(join(here, "webix"), { recursive: true, force: true });
  await cp(join(webixRoot, "src"), join(here, "webix"), { recursive: true });

  // wasm + glue from the installed dependency; rootfs from the webix repo
  // (its npm `files` whitelist omits the tarball, so fetch it).
  await mkdir(join(here, "containers"), { recursive: true });
  await cp(
    join(webixRoot, "containers", "blinkenlib.wasm"),
    join(here, "containers", "blinkenlib.wasm"),
  );
  await cp(
    join(webixRoot, "containers", "blinkenlib.js"),
    join(here, "containers", "blinkenlib.js"),
  );
  const res = await fetch(ROOTFS_URL);
  if (!res.ok) throw new Error(`failed to fetch rootfs: ${res.status}`);
  await writeFile(
    join(here, "containers", "alpine-minirootfs-x86_64.tar.gz"),
    new Uint8Array(await res.arrayBuffer()),
  );

  // zod ESM (self-contained single file)
  await mkdir(join(here, "vendor"), { recursive: true });
  const zodMjs = require.resolve("zod").replace(/index\.js$/, "index.mjs");
  await cp(zodMjs, join(here, "vendor", "zod.js"));

  console.log("browser-demo assembled in", here);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
