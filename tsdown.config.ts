import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
  outDir: "dist",
  format: ["esm", "cjs"],
  outExtensions: ({ format }) => ({
    js: format === "cjs" ? ".cjs" : ".js",
  }),
  sourcemap: true,
  dts: true,
  target: "es2020",
  // webix is loaded at runtime (its wasm/glue are fetched), so keep it external.
  external: [/^webix(\/.*)?$/],
  bundle: false,
});
