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
    nosock: boolean;
    vectorISA: string;
  };
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
