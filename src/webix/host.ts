/**
 * WebixHost — lifecycle wrapper around a single webix Blink x86_64 Linux host.
 *
 * One WebixHost backs one Sandbox: the Blink WASM owns the CPU/MMU/syscalls and
 * an in-memory Linux filesystem (MEMFS), so all of a sandbox's commands and file
 * operations share persistent state through the lifetime of the host. There is
 * no network — this is a self-contained, in-browser microVM (the Blink build is
 * NOSOCK: `socket(AF_INET)` returns ENOSYS), so ports/dev-servers/domains are
 * unavailable by construction.
 */

export interface WebixHostOptions {
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

async function fetchBytes(url: string): Promise<Uint8Array> {
  if (isBrowser) {
    const res = await fetch(url);
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

    const wasmUrl = this.opts.wasmUrl ?? DEFAULTS.wasmUrl;
    const glueUrl = this.opts.glueUrl ?? DEFAULTS.glueUrl;

    if (isBrowser) {
      const { createBlinkHostBrowser } = await import("webix/blink-browser");
      this.core = await createBlinkHostBrowser({ wasmUrl, glueUrl });
    } else {
      const { createBlinkHost } = await import("webix/blink");
      this.core = await createBlinkHost({
        wasmPath: this.opts.wasmPath ?? wasmUrl.replace(/^\//, ""),
        gluePath: this.opts.gluePath ?? glueUrl.replace(/^\//, ""),
      });
    }

    const rootfsBytes =
      this.opts.rootfsTarBytes ??
      (await maybeGunzip(
        await fetchBytes(this.opts.rootfsUrl ?? DEFAULTS.rootfsUrl),
      ));
    this.core.mountTarBytes(rootfsBytes);

    // Preload busybox once so each runElf skips the multi-MB FS rewrite.
    try {
      const bb = this.core.Module.FS.readFile(BUSYBOX_PATH);
      this.busyboxHandle = this.core.preloadFile("busybox", bb);
    } catch {
      this.busyboxHandle = null;
    }
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
