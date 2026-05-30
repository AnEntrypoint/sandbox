/**
 * Minimal ambient types for the webix Blink host subpath exports (webix ships
 * plain JS). Covers only the surface WebixHost uses.
 */

interface BlinkFS {
  readFile(path: string): Uint8Array;
  writeFile(path: string, data: Uint8Array | string): void;
  open(path: string, flags: string): number;
  write(
    stream: number,
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ): number;
  close(stream: number): void;
  mkdir(path: string, mode?: number): void;
  unlink(path: string): void;
  chmod(path: string, mode: number): void;
  symlink(target: string, path: string): void;
  readdir(path: string): string[];
  stat(path: string): { mode: number; size: number };
  analyzePath(path: string): { exists: boolean };
}

interface BlinkSnapshot {
  memory: Uint8Array;
  registers: Record<string, bigint | number>;
  exitCode: number | null;
  stdoutTail: string;
  stderrTail: string;
}

interface BlinkCore {
  Module: {
    FS: BlinkFS;
    wasmExports: { memory: WebAssembly.Memory };
  };
  clstruct: number;
  capabilities: {
    tarMount: boolean;
    nodefs: boolean;
    sockets: boolean;
    threads: boolean;
    sharedMemory: boolean;
    pipe: boolean;
    pipelines: boolean;
    fork: boolean;
    framebuffer: boolean;
    jit: boolean;
    vectorISA: string;
  };
  fbInfo(): {
    vaddr: number;
    width: number;
    height: number;
    stride: number;
    generation: number;
  } | null;
  fbView(): {
    pixels: Uint8ClampedArray;
    width: number;
    height: number;
    stride: number;
    generation: number;
  } | null;
  pushInput(evt: {
    type: "key" | "motion" | "button";
    code?: number;
    button?: number;
    x?: number;
    y?: number;
    down?: number;
    value?: number;
  }): boolean;
  inputPending(): number;
  mountTarBytes(tarBytes: Uint8Array, onError?: (m: string, e: Error) => void): void;
  mountNodeDir(hostDir: string, guestDir?: string): string;
  persistDir(guestDir?: string): Promise<string>;
  syncPersist(): Promise<void>;
  preloadFile(name: string, bytes: Uint8Array): string;
  isPreloaded(handle: string): boolean;
  runElf(
    bytes: Uint8Array | null,
    opts?: { argv?: string[]; progname?: string; path?: string },
  ): Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
    signal: { sig: number; code: number } | null;
  }>;
  /**
   * Run two guests concurrently on their own worker pthreads — an X server
   * (Xvfb) that serves forever and an X client that connects to it over the
   * in-process AF_UNIX layer. Returns once the client exits (or the overall
   * timeout fires); the server is left RUNNING.
   */
  runConcurrent(
    serverBytes: Uint8Array,
    clientBytes: Uint8Array,
    opts?: {
      serverArgv?: string[];
      serverProgname?: string;
      clientArgv?: string[];
      clientProgname?: string;
      clientDelayMs?: number;
      overallTimeoutMs?: number;
    },
  ): Promise<{
    timedOut: boolean;
    client: { exitCode: number | string; stdout: string; stderr: string };
    server: { exitCode: number | string; stdout: string; stderr: string };
  }>;
  pushStdin(bytes: Uint8Array | number[]): void;
  runShellScript(
    busyboxBytes: Uint8Array,
    scriptText: string,
    opts?: { argv?: string[]; progname?: string },
  ): Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
    signal: { sig: number; code: number } | null;
  }>;
  snapshot(): BlinkSnapshot;
  restore(snap: BlinkSnapshot): void;
  readRegisters(): Record<string, bigint | number>;
}

declare module "webix/blink-core" {
  export function createBlinkCore(args: {
    wasmBinary?: Uint8Array;
    factory: unknown;
    options?: Record<string, unknown>;
  }): Promise<BlinkCore>;
}

declare module "webix/alpine-apk" {
  interface ApkRepo {
    search(
      query: string,
      opts?: { gui?: boolean; offset?: number; limit?: number },
    ): Promise<{ packages: { name: string; version: string; summary: string }[]; total: number }>;
    pkgInfo(name: string): Promise<{ name: string; version: string; summary: string; depends: string[]; repo: string } | null>;
  }
  interface Apk extends ApkRepo {
    addByName(name: string): Promise<unknown>;
    remove(name: string): { name: string; removed: boolean };
    list(): { name: string; version: string; fileCount: number }[];
    isInstalled(name: string): boolean;
    repo: ApkRepo;
  }
  export function createApk(
    host: unknown,
    opts?: { root?: string; fetchImpl?: unknown; repoOpts?: unknown },
  ): Apk;
}

declare module "webix/blink" {
  export function createBlinkHost(options?: {
    wasmPath?: string;
    gluePath?: string;
    wasmBinary?: Uint8Array;
    [k: string]: unknown;
  }): Promise<BlinkCore>;
}

declare module "webix/blink-browser" {
  export function createBlinkHostBrowser(options?: {
    wasmUrl?: string;
    glueUrl?: string;
    wasmBinary?: Uint8Array;
    [k: string]: unknown;
  }): Promise<BlinkCore>;
}

declare module "webix/display" {
  export function attachDisplay(
    host: unknown,
    canvas: unknown,
    opts?: { fpsCap?: number },
  ): { stats: () => unknown; stop: () => void };
}
