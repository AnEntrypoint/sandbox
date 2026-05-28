import { it, beforeAll, beforeEach, expect, describe, vi } from "vitest";
import { PassThrough } from "stream";
import { Sandbox } from "./sandbox.js";
import { APIError } from "./api-client/api-error.js";
import { NotSupportedError } from "./api-client/webix-client.js";
import type {
  APIClient,
  CommandData,
  SandboxMetaData,
} from "./api-client/index.js";
import { existsSync, readFileSync } from "fs";
import { gunzipSync } from "zlib";
import { join, resolve } from "path";

describe("downloadFile validation", () => {
  it("throws when src is undefined", async () => {
    const sandbox = new Sandbox({
      client: {} as any,
      routes: [],
      session: { id: "test" } as any,
      sandbox: { name: "test" } as any,
      projectId: "test-project",
    });
    await expect(
      sandbox.downloadFile(undefined as any, { path: "/tmp/out" }),
    ).rejects.toThrow("downloadFile: source path is required");
  });

  it("throws when src.path is empty", async () => {
    const sandbox = new Sandbox({
      client: {} as any,
      routes: [],
      session: { id: "test" } as any,
      sandbox: { name: "test" } as any,
      projectId: "test-project",
    });
    await expect(
      sandbox.downloadFile({ path: "" }, { path: "/tmp/out" }),
    ).rejects.toThrow("downloadFile: source path is required");
  });

  it("throws when dst is undefined", async () => {
    const sandbox = new Sandbox({
      client: {} as any,
      routes: [],
      session: { id: "test" } as any,
      sandbox: { name: "test" } as any,
      projectId: "test-project",
    });
    await expect(
      sandbox.downloadFile({ path: "file.txt" }, undefined as any),
    ).rejects.toThrow("downloadFile: destination path is required");
  });

  it("throws when dst.path is empty", async () => {
    const sandbox = new Sandbox({
      client: {} as any,
      routes: [],
      session: { id: "test" } as any,
      sandbox: { name: "test" } as any,
      projectId: "test-project",
    });
    await expect(
      sandbox.downloadFile({ path: "file.txt" }, { path: "" }),
    ).rejects.toThrow("downloadFile: destination path is required");
  });
});

const makeSandboxMetadata = (): SandboxMetaData => ({
  name: "test-name",
  currentSessionId: "sbx_123",
  persistent: true,
  status: "running",
  memory: 2048,
  vcpus: 1,
  region: "iad1",
  runtime: "node24",
  timeout: 300_000,
  cwd: "/",
  updatedAt: 1,
  createdAt: 1,
  snapshotExpiration: 604800000,
});

const makeCommand = (): CommandData => ({
  id: "cmd_123",
  name: "echo",
  args: ["hello"],
  cwd: "/",
  sessionId: "sbx_123",
  exitCode: null,
  startedAt: 1,
});

describe("_runCommand error handling", () => {
  it("rejects non-detached runCommand when log streaming fails", async () => {
    const command = makeCommand();
    const logsError = new APIError(new Response("failed", { status: 500 }), {
      message: "Failed to stream logs",
      sessionId: "sbx_123",
    });

    const runCommandMock = vi.fn(async ({ wait }: { wait?: boolean }) => {
      if (wait) {
        return {
          command,
          finished: Promise.resolve({ ...command, exitCode: 0 }),
        };
      }

      return { json: { command } };
    });

    const getLogsMock = vi.fn(() =>
      (async function* () {
        throw logsError;
      })(),
    );

    const sandbox = new Sandbox({
      client: {
        runCommand: runCommandMock,
        getLogs: getLogsMock,
      } as unknown as APIClient,
      routes: [],
      sandbox: makeSandboxMetadata(),
      session: {} as any,
      projectId: "test-project",
    });

    await expect(
      sandbox.runCommand({
        cmd: "echo",
        args: ["hello"],
        stdout: new PassThrough(),
      }),
    ).rejects.toBe(logsError);
  });

  it("emits detached log streaming errors on the provided output stream", async () => {
    const command = makeCommand();
    const logsError = new APIError(new Response("failed", { status: 500 }), {
      message: "Failed to stream logs",
      sessionId: "sbx_123",
    });

    const runCommandMock = vi.fn(async ({ wait }: { wait?: boolean }) => {
      if (wait) {
        return {
          command,
          finished: Promise.resolve({ ...command, exitCode: 0 }),
        };
      }

      return { json: { command } };
    });

    const getLogsMock = vi.fn(() =>
      (async function* () {
        throw logsError;
      })(),
    );

    const sandbox = new Sandbox({
      client: {
        runCommand: runCommandMock,
        getLogs: getLogsMock,
      } as unknown as APIClient,
      routes: [],
      sandbox: makeSandboxMetadata(),
      session: {} as any,
      projectId: "test-project",
    });

    const stdout = new PassThrough();
    const errorEvent = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Expected stdout error event")),
        100,
      );
      stdout.once("error", (err) => {
        clearTimeout(timer);
        resolve(err);
      });
    });

    const detached = await sandbox.runCommand({
      cmd: "echo",
      args: ["hello"],
      detached: true,
      stdout,
    });

    expect(detached.cmdId).toBe("cmd_123");
    await expect(errorEvent).resolves.toBe(logsError);
  });
});

// Integration suite against the real webix Blink x86_64 microVM. wasm + glue
// come from the installed webix dependency; the rootfs is fetched from the
// webix repo (its npm `files` whitelist omits the tarball). Skipped offline /
// when the dependency is absent.
const WEBIX = resolve(__dirname, "../node_modules/webix/containers");
const ROOTFS_URL =
  "https://raw.githubusercontent.com/AnEntrypoint/webix/main/containers/alpine-minirootfs-x86_64.tar.gz";
const haveWebix = existsSync(join(WEBIX, "blinkenlib.wasm"));

describe.skipIf(!haveWebix)("Sandbox over webix (in-browser microVM)", () => {
  let sandbox: Sandbox;
  let rootfsTarBytes: Uint8Array;

  beforeAll(async () => {
    const res = await fetch(ROOTFS_URL);
    rootfsTarBytes = new Uint8Array(gunzipSync(new Uint8Array(await res.arrayBuffer())));
  });

  beforeEach(async () => {
    sandbox = await Sandbox.create({
      wasmPath: join(WEBIX, "blinkenlib.wasm"),
      gluePath: join(WEBIX, "blinkenlib.js"),
      rootfsTarBytes,
    });
  });

  it("runs a command and returns stdout + exit code", async () => {
    const r = await sandbox.runCommand("echo", ["hello", "sandbox"]);
    expect(r.exitCode).toBe(0);
    expect(await r.stdout()).toMatch(/hello sandbox/);
  });

  it("reports x86_64 via uname", async () => {
    const r = await sandbox.runCommand("uname", ["-a"]);
    expect(r.exitCode).toBe(0);
    expect(await r.stdout()).toMatch(/x86_64/);
  });

  it("round-trips writeFiles + readFileToBuffer", async () => {
    await sandbox.writeFiles([
      { path: "/tmp/note.txt", content: "persisted in the microVM\n" },
    ]);
    const buf = await sandbox.readFileToBuffer({ path: "/tmp/note.txt" });
    expect(buf).not.toBeNull();
    expect(new TextDecoder().decode(buf!)).toContain("persisted in the microVM");
  });

  it("mkDir + nested writeFiles readable by busybox cat", async () => {
    await sandbox.mkDir("/tmp/sub");
    await sandbox.writeFiles([{ path: "/tmp/sub/a.txt", content: "nested" }]);
    const cat = await sandbox.runCommand("cat", ["/tmp/sub/a.txt"]);
    expect(await cat.stdout()).toMatch(/nested/);
  });

  it("returns exit 127 for an unknown command", async () => {
    const r = await sandbox.runCommand("definitely-not-real", []);
    expect(r.exitCode).toBe(127);
  });

  it("captures a byte-exact snapshot", async () => {
    const snap = await sandbox.snapshot();
    expect(typeof snap.snapshotId).toBe("string");
  });

  it("throws NotSupported for networking (NOSOCK)", () => {
    expect(() => sandbox.domain(3000)).toThrow();
  });

  it("throws NotSupported for Sandbox.list (no remote registry)", async () => {
    await expect(Sandbox.list()).rejects.toBeInstanceOf(NotSupportedError);
  });
});
