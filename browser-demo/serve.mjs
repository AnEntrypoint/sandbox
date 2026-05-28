import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, normalize, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const PORT = Number(process.env.PORT || 8127);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".gz": "application/gzip",
  ".tar": "application/x-tar",
  ".css": "text/css; charset=utf-8",
};

http
  .createServer(async (req, res) => {
    try {
      const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
      const rel = normalize(urlPath === "/" ? "/index.html" : urlPath).replace(/^(\.\.[/\\])+/, "");
      const file = join(ROOT, rel);
      const data = await readFile(file);
      // Do not gzip-encode .tar.gz responses: the rootfs is gunzipped in-app,
      // so it must arrive as raw gzip bytes (no Content-Encoding).
      res.writeHead(200, {
        "content-type": MIME[extname(file).toLowerCase()] || "application/octet-stream",
        "cache-control": "no-cache",
      });
      res.end(data);
    } catch {
      res.writeHead(404);
      res.end("not found");
    }
  })
  .listen(PORT, () => console.log(`serving browser-demo on http://localhost:${PORT}/`));
