/**
 * WebixHost — lifecycle wrapper around a single webix Blink x86_64 Linux host.
 *
 * One WebixHost backs one Sandbox: the Blink WASM owns the CPU/MMU/syscalls and
 * an in-memory Linux filesystem (MEMFS), so all of a sandbox's commands and file
 * operations share persistent state through the lifetime of the host. There is
 * no remote network — this is a self-contained, in-browser microVM, so
 * remote ports/dev-servers/public domains are unavailable by construction.
 * The portabox build additionally exposes a framebuffer + input device (see
 * fbView/attachDisplay/pushInput) and is threaded + sockets-enabled (socket()
 * works in-process); fork() remains absent (emscripten limitation).
 */

/** Boot progress stages emitted by {@link WebixHost.boot}, in order. */
export type BootStage =
  | "runtime"   // fetching + instantiating the wasm runtime
  | "rootfs"    // fetching + decompressing the root filesystem
  | "mount"     // mounting the rootfs + preloading busybox
  | "ready";    // boot complete

export interface WebixHostOptions {
  /** Called as boot advances through its stages, for a legible cold-boot UI. */
  onProgress?: (stage: BootStage) => void;
  /** URL of the Blink wasm. Defaults to `/containers/blinkenlib.wasm`. */
  wasmUrl?: string;
  /** URL of the Blink emscripten glue JS. Defaults to `/containers/blinkenlib.js`. */
  glueUrl?: string;
  /**
   * URL of the root filesystem tarball (optionally gzipped) mounted at `/`.
   * Defaults to `/containers/alpine-minirootfs-x86_64.tar.gz`.
   */
  rootfsUrl?: string;
  /** Raw rootfs tar bytes (skips the fetch); takes precedence over rootfsUrl. */
  rootfsTarBytes?: Uint8Array;
  /** Node-only: filesystem path to the wasm (skips fetch). */
  wasmPath?: string;
  /** Node-only: filesystem path to the glue JS. */
  gluePath?: string;
}

const DEFAULTS = {
  // Browser default: assets served same-origin under /containers/ (correct MIME
  // for streaming-compiled wasm + dynamic-imported glue). Serve your own copies
  // (e.g. from node_modules/webix/containers) or override these per call.
  wasmUrl: "/containers/blinkenlib.wasm",
  glueUrl: "/containers/blinkenlib.js",
  rootfsUrl: "/containers/alpine-minirootfs-x86_64.tar.gz",
};

const BUSYBOX_PATH = "/bin/busybox";

const isBrowser =
  typeof (globalThis as { window?: unknown }).window !== "undefined" &&
  typeof fetch !== "undefined";

type BlinkCore = Awaited<
  ReturnType<typeof import("webix/blink-core").createBlinkCore>
>;

/** Gunzip bytes if they carry the gzip magic, else return as-is. */
async function maybeGunzip(bytes: Uint8Array): Promise<Uint8Array> {
  if (bytes.length < 2 || bytes[0] !== 0x1f || bytes[1] !== 0x8b) return bytes;
  if (typeof DecompressionStream !== "undefined") {
    const ds = new DecompressionStream("gzip");
    const stream = new Response(bytes).body!.pipeThrough(ds);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  const { gunzipSync } = await import("node:zlib");
  return new Uint8Array(gunzipSync(bytes));
}

/**
 * The Blink faketty echoes the command line as a shell prompt before the real
 * output: `\n$ <argv joined by space>\n<output>`. Strip exactly that known
 * prefix so runCommand stdout is the command's actual output. Matching the
 * exact joined argv (not a generic `$ ` regex) avoids clobbering output that
 * legitimately contains `$ ` lines.
 */
function stripBlinkPrompt(stdout: string, argv: string[]): string {
  const prompt = "$ " + argv.join(" ") + "\n";
  if (stdout.startsWith(prompt)) return stdout.slice(prompt.length);
  if (stdout.startsWith("\n" + prompt)) return stdout.slice(prompt.length + 1);
  return stdout;
}

/** Versioned Cache API bucket for the multi-MB rootfs/wasm assets. Bump the
 * suffix when the asset format changes to invalidate stale entries. */
const ASSET_CACHE = "webix-assets-v1";

/**
 * Fetch the same-origin asset bytes, served from the Cache API on repeat loads.
 * The rootfs tarball is multi-MB; caching it means the first paint pays the
 * network cost once and every subsequent page load reads it from disk cache
 * with no network round-trip. Falls back to a plain fetch where the Cache API
 * is unavailable (older browsers, non-secure contexts).
 */
async function fetchResponse(url: string): Promise<Response> {
  if (typeof caches !== "undefined") {
    try {
      const cache = await caches.open(ASSET_CACHE);
      const hit = await cache.match(url);
      if (hit) return hit;
      const res = await fetch(url);
      if (res.ok) {
        // Cache a clone; the original is consumed by the caller.
        await cache.put(url, res.clone());
      }
      return res;
    } catch {
      // Cache API can throw in opaque/insecure contexts — fall through.
    }
  }
  return fetch(url);
}

async function fetchBytes(url: string): Promise<Uint8Array> {
  if (isBrowser) {
    const res = await fetchResponse(url);
    if (!res.ok) {
      throw new Error(
        `webix: failed to fetch ${url} (HTTP ${res.status}). The wasm must be served with Content-Type: application/wasm.`,
      );
    }
    return new Uint8Array(await res.arrayBuffer());
  }
  const { readFile } = await import("node:fs/promises");
  const { fileURLToPath } = await import("node:url");
  const path = url.startsWith("file:") ? fileURLToPath(url) : url;
  return new Uint8Array(await readFile(path));
}

export class WebixHost {
  private core: BlinkCore | null = null;
  private busyboxHandle: string | null = null;
  private runQueue: Promise<unknown> = Promise.resolve();
  private stopped = false;
  private readonly opts: WebixHostOptions;

  constructor(opts: WebixHostOptions = {}) {
    this.opts = opts;
  }

  /** Boot the Blink host, mount the rootfs, and preload busybox. Idempotent. */
  async boot(): Promise<void> {
    if (this.core) return;

    const progress = this.opts.onProgress ?? (() => {});
    const wasmUrl = this.opts.wasmUrl ?? DEFAULTS.wasmUrl;
    const glueUrl = this.opts.glueUrl ?? DEFAULTS.glueUrl;

    progress("runtime");
    if (isBrowser) {
      const { createBlinkHostBrowser } = await import("webix/blink-browser");
      this.core = await createBlinkHostBrowser({ wasmUrl, glueUrl });
    } else {
      // The threaded (-pthread) emscripten glue references the worker-scope
      // global `self` at module-eval time; on Node's main thread that is
      // undefined. Shim it to globalThis so the threaded artifact loads under
      // Node (the pthread pool spawns real worker_threads that set their own
      // scope). Harmless on the single-thread build.
      const g = globalThis as { self?: unknown };
      if (typeof g.self === "undefined") g.self = globalThis;
      // Node-only host (pulls node:fs via webix/blink). Marked bundler-ignored
      // so browser bundlers (Next/Turbopack) don't try to chunk it into the
      // client build — this branch only runs under Node.
      const { createBlinkHost } = await import(
        /* webpackIgnore: true */ /* @vite-ignore */ "webix/blink"
      );
      this.core = await createBlinkHost({
        wasmPath: this.opts.wasmPath ?? wasmUrl.replace(/^\//, ""),
        gluePath: this.opts.gluePath ?? glueUrl.replace(/^\//, ""),
      });
    }

    progress("rootfs");
    const rootfsBytes =
      this.opts.rootfsTarBytes ??
      (await maybeGunzip(
        await fetchBytes(this.opts.rootfsUrl ?? DEFAULTS.rootfsUrl),
      ));
    progress("mount");
    this.core.mountTarBytes(rootfsBytes);

    // Preload busybox once so each runElf skips the multi-MB FS rewrite.
    try {
      const bb = this.core.Module.FS.readFile(BUSYBOX_PATH);
      this.busyboxHandle = this.core.preloadFile("busybox", bb);
    } catch {
      this.busyboxHandle = null;
    }
    progress("ready");
  }

  private ensureCore(): BlinkCore {
    if (this.stopped) throw new Error("webix: sandbox has been stopped");
    if (!this.core) throw new Error("webix: host not booted (call boot())");
    return this.core;
  }

  get fs(): BlinkCore["Module"]["FS"] {
    return this.ensureCore().Module.FS;
  }

  /** Whether `/bin/busybox` exists in the mounted rootfs. */
  get hasBusybox(): boolean {
    return this.busyboxHandle !== null;
  }

  /**
   * Run an ELF (by guest-FS path or raw bytes) to completion. Calls are
   * serialized: Blink is single-threaded and rejects overlapping runs, so we
   * chain them through an internal queue.
   */
  runElf(
    elf: { path?: string; bytes?: Uint8Array },
    argv: string[],
  ): Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
    signal: { sig: number; code: number } | null;
  }> {
    const run = this.runQueue.then(async () => {
      const core = this.ensureCore();
      const r = await core.runElf(elf.bytes ?? null, { argv, path: elf.path });
      return { ...r, stdout: stripBlinkPrompt(r.stdout, argv) };
    });
    // Keep the queue alive regardless of individual failures.
    this.runQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * Run an X server (Xvfb) and an X client concurrently in-page, each on its
   * own worker pthread, talking over blink's in-process AF_UNIX layer. Resolves
   * when the client exits (server kept RUNNING). Serialized through the run
   * queue like runElf — it holds the host for its whole duration.
   */
  runConcurrent(
    server: { bytes: Uint8Array; argv?: string[]; progname?: string },
    client: { bytes: Uint8Array; argv?: string[]; progname?: string },
    opts?: { clientDelayMs?: number; overallTimeoutMs?: number },
  ): Promise<{
    timedOut: boolean;
    client: { exitCode: number | string; stdout: string; stderr: string };
    server: { exitCode: number | string; stdout: string; stderr: string };
  }> {
    const run = this.runQueue.then(async () => {
      const core = this.ensureCore();
      if (typeof core.runConcurrent !== "function") {
        throw new Error(
          "webix: runConcurrent missing (rebuild blink/blink-core)",
        );
      }
      return core.runConcurrent(server.bytes, client.bytes, {
        serverArgv: server.argv ?? [],
        serverProgname: server.progname ?? "/xserver",
        clientArgv: client.argv ?? [],
        clientProgname: client.progname ?? "/xclient",
        ...opts,
      });
    });
    this.runQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Run a command via busybox: `busybox <argv...>` (applet dispatch). */
  runBusybox(
    argv: string[],
  ): Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
    signal: { sig: number; code: number } | null;
  }> {
    if (!this.busyboxHandle) {
      throw new Error("webix: busybox not present in rootfs");
    }
    return this.runElf({ path: this.busyboxHandle }, argv);
  }

  /**
   * Framebuffer geometry the guest published via syscall 0x5fb, or null if no
   * guest has registered a framebuffer yet.
   */
  fbInfo(): {
    vaddr: number;
    width: number;
    height: number;
    stride: number;
    generation: number;
  } | null {
    return (this.ensureCore() as any).fbInfo?.() ?? null;
  }

  /**
   * Zero-copy view over the guest framebuffer (re-derived each call; safe
   * against ALLOW_MEMORY_GROWTH detach). Null until a guest registers one.
   */
  fbView(): { pixels: Uint8ClampedArray; width: number; height: number; stride: number; generation: number } | null {
    return (this.ensureCore() as any).fbView?.() ?? null;
  }

  /**
   * Attach a canvas to the live framebuffer via webix's display module: a rAF
   * blit loop that paints guest pixels and forwards canvas key/mouse events
   * into the guest input device. Returns a controller with stats()/stop().
   */
  async attachDisplay(
    canvas: unknown,
    opts?: { fpsCap?: number },
  ): Promise<{ stats: () => unknown; stop: () => void }> {
    const core = this.ensureCore();
    const { attachDisplay } = (await import("webix/display")) as {
      attachDisplay: (
        host: unknown,
        canvas: unknown,
        opts?: { fpsCap?: number },
      ) => { stats: () => unknown; stop: () => void };
    };
    return attachDisplay(core, canvas, opts);
  }

  /**
   * Push one input event into the guest input ring (host -> guest). Event
   * shape: { type: "key"|"motion"|"button", code?, button?, x?, y?, down? }.
   * Returns false if the running wasm predates the input device.
   */
  pushInput(evt: {
    type: "key" | "motion" | "button";
    code?: number;
    button?: number;
    x?: number;
    y?: number;
    down?: number;
    value?: number;
  }): boolean {
    return (this.ensureCore() as any).pushInput?.(evt) ?? false;
  }

  /** Capability flags of the running Blink build. */
  get capabilities(): Record<string, unknown> {
    return (this.ensureCore() as any).capabilities ?? {};
  }

  snapshot() {
    return this.ensureCore().snapshot();
  }

  restore(snap: ReturnType<BlinkCore["snapshot"]>) {
    this.ensureCore().restore(snap);
  }

  stop(): void {
    this.stopped = true;
    this.core = null;
    this.busyboxHandle = null;
  }
}
