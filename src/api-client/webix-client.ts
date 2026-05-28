/**
 * WebixApiClient — a drop-in replacement for the remote HTTP APIClient that
 * drives a self-contained in-browser x86_64 Linux microVM (webix / Blink WASM)
 * instead of contacting Vercel. It implements the same method surface that
 * Sandbox/Session/Snapshot/Command call, returning the same `{ json }`-wrapped
 * response shapes, so the higher-level classes are unchanged.
 *
 * There is no network: the Blink build is NOSOCK, so ports/domains/dev-servers
 * are unavailable and the corresponding methods throw {@link NotSupportedError}.
 */
import { WebixHost, type WebixHostOptions } from "../webix/host.js";
import { normalizePath } from "../utils/normalizePath.js";
import type {
  SessionMetaData,
  SandboxMetaData,
  SnapshotMetadata,
  CommandData,
  CommandFinishedData,
  SandboxRouteData,
} from "./validators.js";

export class NotSupportedError extends Error {
  name = "NotSupportedError";
}

/** Wrap a value as the `{ json }` Parsed shape the callers consume. */
function parsed<T>(json: T): { json: T; response: Response; text: string } {
  return { json, response: new Response(null), text: "" };
}

function now(): number {
  return Date.now();
}

interface StoredCommand {
  data: CommandData;
  finished?: CommandFinishedData;
  stdout: string;
  stderr: string;
}

interface StoredSnapshot {
  meta: SnapshotMetadata;
  blink: ReturnType<WebixHost["snapshot"]>;
}

const DEFAULT_CWD = "/root";

export class WebixApiClient {
  private host: WebixHost;
  private booted = false;
  private sessionId = "sbx_local_" + Math.random().toString(36).slice(2, 12);
  private sandboxName: string;
  private runtime: string;
  private cwd = DEFAULT_CWD;
  private status: SessionMetaData["status"] = "pending";
  private commands = new Map<string, StoredCommand>();
  private snapshots = new Map<string, StoredSnapshot>();
  private createdAt = now();

  constructor(opts: WebixHostOptions & { name?: string; runtime?: string } = {}) {
    this.host = new WebixHost(opts);
    this.sandboxName = opts.name ?? "local-" + Math.random().toString(36).slice(2, 8);
    this.runtime = opts.runtime ?? "x86_64-linux";
  }

  private async ensureBooted(): Promise<void> {
    if (this.booted) return;
    await this.host.boot();
    this.booted = true;
    this.status = "running";
  }

  private sessionMeta(): SessionMetaData {
    return {
      id: this.sessionId,
      memory: 2048,
      vcpus: 1,
      region: "local",
      runtime: this.runtime,
      timeout: 0,
      status: this.status,
      requestedAt: this.createdAt,
      startedAt: this.createdAt,
      createdAt: this.createdAt,
      updatedAt: now(),
      cwd: this.cwd,
    };
  }

  private sandboxMeta(): SandboxMetaData {
    return {
      name: this.sandboxName,
      persistent: false,
      region: "local",
      vcpus: 1,
      memory: 2048,
      runtime: this.runtime,
      timeout: 0,
      createdAt: this.createdAt,
      updatedAt: now(),
      currentSessionId: this.sessionId,
      status: this.status,
      cwd: this.cwd,
    };
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────

  async createSandbox(params: { name?: string; runtime?: string; cwd?: string }) {
    if (params.name) this.sandboxName = params.name;
    if (params.runtime) this.runtime = params.runtime;
    await this.ensureBooted();
    if (params.cwd) this.cwd = params.cwd;
    return parsed({
      sandbox: this.sandboxMeta(),
      session: this.sessionMeta(),
      routes: [] as SandboxRouteData[],
    });
  }

  async getSandbox() {
    await this.ensureBooted();
    return parsed({
      sandbox: this.sandboxMeta(),
      session: this.sessionMeta(),
      routes: [] as SandboxRouteData[],
    });
  }

  async getSession(_params?: { sessionId?: string; signal?: AbortSignal }) {
    return parsed({ session: this.sessionMeta(), routes: [] as SandboxRouteData[] });
  }

  async stopSession(_params?: { sessionId?: string; signal?: AbortSignal }) {
    this.status = "stopped";
    this.host.stop();
    return parsed({
      session: this.sessionMeta(),
      sandbox: this.sandboxMeta(),
      snapshot: undefined as SnapshotMetadata | undefined,
    });
  }

  async extendTimeout(_params?: {
    sessionId?: string;
    duration?: number;
    signal?: AbortSignal;
  }) {
    // No timeout for a local sandbox; the host lives until stopped.
    return parsed({ session: this.sessionMeta() });
  }

  // ── Commands ───────────────────────────────────────────────────────────

  /** Resolve and run a command, returning its full result. */
  private async exec(
    command: string,
    args: string[],
    cwd?: string,
    env?: Record<string, string>,
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    await this.ensureBooted();
    const wd = cwd ?? this.cwd;

    // Build the argv. To honor cwd/env without shell-injection, run the command
    // under `env` + a `cd` via busybox `sh -c` ONLY with a safely-quoted line;
    // otherwise invoke the applet/binary directly.
    const needsShell = !!cwd || (env && Object.keys(env).length > 0);
    const fs = this.host.fs;
    const isAbsolute = command.startsWith("/");
    const exists = (p: string) => {
      try {
        fs.stat(p);
        return true;
      } catch {
        return false;
      }
    };

    if (!needsShell) {
      // Absolute path to a binary in the guest → run it directly.
      if (isAbsolute && exists(command)) {
        const bytes = fs.readFile(command);
        return this.host.runElf({ bytes }, [command.split("/").pop()!, ...args]);
      }
      // Otherwise dispatch as a busybox applet.
      return this.host.runBusybox([command, ...args]);
    }

    // Shell path: cd + env, with every value single-quote-escaped.
    const q = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'";
    const envPrefix = env
      ? Object.entries(env)
          .map(([k, v]) => `${k}=${q(v)}`)
          .join(" ") + " "
      : "";
    const line = `cd ${q(wd)} && ${envPrefix}${[command, ...args].map(q).join(" ")}`;
    return this.host.runBusybox(["sh", "-c", line]);
  }

  async runCommand(params: {
    sessionId: string;
    cwd?: string;
    command: string;
    args: string[];
    env: Record<string, string>;
    sudo: boolean;
    wait: true;
    signal?: AbortSignal;
  }): Promise<{ command: CommandData; finished: Promise<CommandFinishedData> }>;
  async runCommand(params: {
    sessionId: string;
    cwd?: string;
    command: string;
    args: string[];
    env: Record<string, string>;
    sudo: boolean;
    wait?: false;
    signal?: AbortSignal;
  }): Promise<{ json: { command: CommandData } }>;
  async runCommand(params: {
    sessionId?: string;
    cwd?: string;
    command: string;
    args: string[];
    env: Record<string, string>;
    sudo: boolean;
    wait?: boolean;
    signal?: AbortSignal;
  }): Promise<
    | { command: CommandData; finished: Promise<CommandFinishedData> }
    | { json: { command: CommandData } }
  > {
    const id = "cmd_" + Math.random().toString(36).slice(2, 12);
    const startedAt = now();
    const baseCmd: CommandData = {
      id,
      name: params.command,
      args: params.args,
      cwd: params.cwd ?? this.cwd,
      sessionId: this.sessionId,
      exitCode: null,
      startedAt,
    };

    if (params.wait) {
      const stored: StoredCommand = { data: baseCmd, stdout: "", stderr: "" };
      this.commands.set(id, stored);
      const finished = (async (): Promise<CommandFinishedData> => {
        const r = await this.exec(
          params.command,
          params.args,
          params.cwd,
          params.env,
        );
        stored.stdout = r.stdout;
        stored.stderr = r.stderr;
        const fin: CommandFinishedData = { ...baseCmd, exitCode: r.exitCode };
        stored.finished = fin;
        return fin;
      })();
      return { command: baseCmd, finished };
    }

    // Detached: kick off, store result when done.
    const stored: StoredCommand = { data: baseCmd, stdout: "", stderr: "" };
    this.commands.set(id, stored);
    void this.exec(params.command, params.args, params.cwd, params.env).then(
      (r) => {
        stored.stdout = r.stdout;
        stored.stderr = r.stderr;
        stored.finished = { ...baseCmd, exitCode: r.exitCode };
      },
    );
    return { json: { command: baseCmd } };
  }

  async getCommand(params: {
    sessionId?: string;
    cmdId: string;
    wait?: boolean;
    signal?: AbortSignal;
  }) {
    const stored = this.commands.get(params.cmdId);
    if (!stored) throw new Error(`webix: unknown command ${params.cmdId}`);
    if (params.wait && stored.finished) {
      return parsed({ command: stored.finished });
    }
    return parsed({ command: stored.finished ?? stored.data });
  }

  async killCommand(params: {
    sessionId?: string;
    commandId: string;
    signal?: number;
    abortSignal?: AbortSignal;
  }) {
    // Runs are synchronous to completion; nothing to interrupt mid-run.
    const stored = this.commands.get(params.commandId);
    return parsed({ command: stored?.finished ?? stored?.data ?? null });
  }

  getLogs(params: {
    sessionId?: string;
    cmdId: string;
    signal?: AbortSignal;
  }): AsyncGenerator<
    { stream: "stdout" | "stderr"; data: string },
    void,
    void
  > &
    Disposable & { close(): void } {
    const stored = this.commands.get(params.cmdId);
    const gen = (async function* () {
      if (!stored) return;
      // Yield buffered output line-by-line once the run has settled.
      const emit = function* (
        text: string,
        stream: "stdout" | "stderr",
      ): Generator<{ stream: "stdout" | "stderr"; data: string }> {
        for (const line of text.split(/(?<=\n)/)) {
          if (line) yield { stream, data: line };
        }
      };
      yield* emit(stored.stdout, "stdout");
      yield* emit(stored.stderr, "stderr");
    })();
    return Object.assign(gen, {
      [Symbol.dispose]() {},
      close() {},
    });
  }

  // ── Filesystem ─────────────────────────────────────────────────────────

  async mkDir(params: {
    sessionId?: string;
    path: string;
    cwd?: string;
    signal?: AbortSignal;
  }) {
    await this.ensureBooted();
    const full = normalizePath({
      filePath: params.path,
      cwd: params.cwd ?? this.cwd,
      extractDir: "/",
    });
    this.mkdirp("/" + full);
    return parsed({});
  }

  private mkdirp(p: string): void {
    const fs = this.host.fs;
    let cur = "";
    for (const seg of p.split("/").filter(Boolean)) {
      cur += "/" + seg;
      try {
        fs.mkdir(cur, 0o755);
      } catch {
        /* exists */
      }
    }
  }

  getFileWriter(params: {
    sessionId?: string;
    extractDir: string;
    signal?: AbortSignal;
  }) {
    const files: { name: string; content: Uint8Array; mode?: number }[] = [];
    const client = this;
    const writer = {
      async addFile(file: {
        name: string;
        content: string | Uint8Array;
        mode?: number;
      }) {
        const content =
          typeof file.content === "string"
            ? new TextEncoder().encode(file.content)
            : file.content;
        files.push({ name: file.name, content, mode: file.mode });
      },
      end() {
        /* settled via response promise below */
      },
    };
    const response = (async () => {
      await client.ensureBooted();
      const fs = client.host.fs;
      for (const f of files) {
        const full = "/" + f.name.replace(/^\/+/, "");
        client.mkdirp(full.replace(/\/[^/]*$/, "") || "/");
        try {
          fs.unlink(full);
        } catch {
          /* new file */
        }
        const s = fs.open(full, "w+");
        if (f.content.length) fs.write(s, f.content, 0, f.content.length, 0);
        fs.close(s);
        fs.chmod(full, f.mode ?? 0o644);
      }
      return parsed({});
    });
    return { writer, response: response() };
  }

  async writeFiles(params: {
    sessionId?: string;
    cwd: string;
    files: { path: string; content: string | Uint8Array; mode?: number }[];
    extractDir: string;
    signal?: AbortSignal;
  }) {
    const { writer, response } = this.getFileWriter({ extractDir: params.extractDir });
    for (const file of params.files) {
      await writer.addFile({
        name: normalizePath({
          filePath: file.path,
          extractDir: params.extractDir,
          cwd: params.cwd,
        }),
        content: file.content,
        mode: file.mode,
      });
    }
    writer.end();
    await response;
    return parsed({});
  }

  async readFile(params: {
    sessionId?: string;
    path: string;
    cwd?: string;
    signal?: AbortSignal;
  }): Promise<ReadableStream | null> {
    await this.ensureBooted();
    const full = "/" + normalizePath({
      filePath: params.path,
      cwd: params.cwd ?? this.cwd,
      extractDir: "/",
    });
    let bytes: Uint8Array;
    try {
      bytes = this.host.fs.readFile(full);
    } catch {
      return null;
    }
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
  }

  // ── Snapshots ──────────────────────────────────────────────────────────

  async createSnapshot(_params?: {
    sessionId?: string;
    expiration?: number;
    signal?: AbortSignal;
  }) {
    await this.ensureBooted();
    const blink = this.host.snapshot();
    const id = "snap_" + Math.random().toString(36).slice(2, 12);
    const meta: SnapshotMetadata = {
      id,
      sourceSessionId: this.sessionId,
      region: "local",
      status: "created",
      sizeBytes: blink.memory.byteLength,
      createdAt: now(),
      updatedAt: now(),
    };
    this.snapshots.set(id, { meta, blink });
    this.status = "running";
    return parsed({ snapshot: meta, session: this.sessionMeta() });
  }

  async getSnapshot(params: { snapshotId: string; signal?: AbortSignal }) {
    const s = this.snapshots.get(params.snapshotId);
    if (!s) throw new Error(`webix: unknown snapshot ${params.snapshotId}`);
    return parsed({ snapshot: s.meta });
  }

  async deleteSnapshot(params: { snapshotId: string; signal?: AbortSignal }) {
    const s = this.snapshots.get(params.snapshotId);
    if (!s) throw new Error(`webix: unknown snapshot ${params.snapshotId}`);
    s.meta.status = "deleted";
    this.snapshots.delete(params.snapshotId);
    return parsed({ snapshot: s.meta });
  }

  async listSnapshots() {
    return parsed({
      snapshots: [...this.snapshots.values()].map((s) => s.meta),
      pagination: { count: this.snapshots.size, next: null },
    });
  }

  async getSnapshotTree() {
    return parsed({
      snapshots: [],
      pagination: { count: 0, next: null },
    });
  }

  /** Restore a previously captured snapshot into the live host. */
  async restoreSnapshot(snapshotId: string): Promise<void> {
    await this.ensureBooted();
    const s = this.snapshots.get(snapshotId);
    if (!s) throw new Error(`webix: unknown snapshot ${snapshotId}`);
    this.host.restore(s.blink);
  }

  // ── Listing ────────────────────────────────────────────────────────────

  async listSessions() {
    return parsed({
      sessions: [this.sessionMeta()],
      pagination: { count: 1, next: null },
    });
  }

  async listSandboxes() {
    return parsed({
      sandboxes: [this.sandboxMeta()],
      pagination: { count: 1, next: null },
    });
  }

  async updateSandbox(params: { runtime?: string; cwd?: string }) {
    if (params.runtime) this.runtime = params.runtime;
    if (params.cwd) this.cwd = params.cwd;
    return parsed({ sandbox: this.sandboxMeta(), routes: [] as SandboxRouteData[] });
  }

  async deleteSandbox() {
    this.status = "stopped";
    this.host.stop();
    return parsed({ sandbox: this.sandboxMeta(), routes: [] as SandboxRouteData[] });
  }

  // ── Networking (unavailable: Blink is NOSOCK) ────────────────────────────

  async updateNetworkPolicy(_params?: {
    sessionId?: string;
    networkPolicy?: unknown;
    signal?: AbortSignal;
  }): Promise<{ json: { session: SessionMetaData } }> {
    throw new NotSupportedError(
      "Network policies are unavailable: the in-browser sandbox has no networking (Blink build is NOSOCK).",
    );
  }
}
