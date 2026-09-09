import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdtemp, mkdir, readFile, readdir, realpath, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { sha256Text } from "@aimd/reader-core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// The runtime packaging helper is intentionally JavaScript so it can run before
// workspace compilation and therefore has no emitted TypeScript declaration.
// @ts-expect-error -- verified through the explicit PackageHelpers contract below.
import * as packageHelpersModule from "../../../scripts/package-plugin.mjs";
import {
  createDefaultCapabilityProbeReport,
  listAuthorizedMcpRoots,
  startProductionReaderServer,
  startReaderServer,
  startProbeServer,
} from "./index.js";
import type { ProductionLiveProbe, ProductionLiveProbeOptions } from "./live-probe.js";
import {
  PROBE_RESOURCE_URI,
  PROBE_SOURCE_URI,
  parseCapabilityProbeReport,
} from "./mcp.js";

const workspaceRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const packageScript = join(workspaceRoot, "scripts", "package-plugin.mjs");

function normalizeTextArtifact(value: string): string {
  return value.replace(/\r\n?|\n/gu, "\n");
}

let temporaryRoot = "";
let pluginRoot = "";
let marketplacePath = "";

type PrivatePackageDirectory = {
  readonly path: string;
  readonly canonicalPath: string;
  readonly parentCanonicalPath: string;
  readonly device: string;
  readonly inode: string;
};

type PackageHelpers = {
  assertArtifactBoundaries(serverText: string, probeText: string): void;
  assertArtifactIsPathClean(text: string, paths: readonly string[]): void;
  assertArtifactHasNoKnownLocalPath(text: string, paths: readonly string[]): void;
  sameCanonicalPath(left: string, right: string, platform?: NodeJS.Platform): boolean;
  isCanonicalPathContained(parent: string, candidate: string, platform?: NodeJS.Platform): boolean;
  createPrivatePackageDirectory(pluginRoot: string): Promise<PrivatePackageDirectory>;
  packagePlugin(options: {
    workspaceRoot: string;
    pluginDir: string;
    marketplacePath: string;
    afterPreviousRename?: () => Promise<void>;
    afterPreviousMoved?: () => Promise<void>;
  }): Promise<{ serverPath: string; probePath: string; readerPath: string; safeWriteHelperPath: string }>;
  removePrivatePackageDirectory(
    directory: PrivatePackageDirectory,
    options?: {
      afterTreeScan?: () => Promise<void>;
      maxTreeEntriesForTesting?: number;
    },
  ): Promise<void>;
  replacePackageDist(options: {
    privateDirectory: PrivatePackageDirectory;
    stagingDist: string;
    targetDist: string;
    afterPreviousRename?: () => Promise<void>;
    afterPreviousMoved?: () => Promise<void>;
  }): Promise<void>;
  validatePluginLaunchConfig(pluginDir: string): Promise<string>;
  validateMarketplaceConfig(workspaceRoot: string, marketplacePath?: string): Promise<unknown>;
};

let packageHelpers: PackageHelpers;

async function firstExistingPath(paths: readonly string[]): Promise<string> {
  for (const path of paths) {
    try {
      await access(path);
      return path;
    } catch {
      // The development host may temporarily expose only .agents-hold while
      // the repository marketplace is restored. The selected path is always
      // passed explicitly and never changes the production default.
    }
  }
  throw new Error("No explicit development marketplace fixture is available");
}

async function runProcess(command: string, args: readonly string[], cwd: string) {
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, NO_COLOR: "1" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  const code = await new Promise<number | null>((accept, reject) => {
    child.once("error", reject);
    child.once("exit", accept);
  });
  return {
    code,
    stdout: Buffer.concat(stdout).toString("utf8"),
    stderr: Buffer.concat(stderr).toString("utf8"),
  };
}

beforeAll(async () => {
  packageHelpers = packageHelpersModule as unknown as PackageHelpers;
  marketplacePath = await firstExistingPath([
    join(workspaceRoot, ".agents", "plugins", "marketplace.json"),
    join(workspaceRoot, ".agents-hold", "plugins", "marketplace.json"),
  ]);
  temporaryRoot = await realpath(await mkdtemp(join(tmpdir(), "aimd-package-test-")));
  pluginRoot = join(temporaryRoot, "original", "aimd-reader");
  await mkdir(pluginRoot, { recursive: true });
  await mkdir(join(pluginRoot, ".codex-plugin"), { recursive: true });
  await mkdir(join(pluginRoot, "dist"), { recursive: true });
  await writeFile(join(pluginRoot, "dist", "previous-build.txt"), "replace me", "utf8");
  await writeFile(
    join(pluginRoot, ".codex-plugin", "plugin.json"),
    JSON.stringify({ name: "aimd-reader", mcpServers: "./.mcp.json" }, null, 2),
    "utf8",
  );
  await writeFile(
    join(pluginRoot, ".mcp.json"),
    JSON.stringify(
      {
        mcpServers: {
          "aimd-reader": { command: "node", cwd: ".", args: ["dist/server.mjs"] },
        },
      },
      null,
      2,
    ),
    "utf8",
  );

  const packaged = await runProcess(
    process.execPath,
    [
      packageScript,
      "--workspace-root",
      workspaceRoot,
      "--plugin-dir",
      pluginRoot,
      "--marketplace-path",
      marketplacePath,
    ],
    workspaceRoot,
  );
  expect(packaged.code, packaged.stderr).toBe(0);
  expect(packaged.stdout).toBe("");
}, 60_000);

afterAll(async () => {
  if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
});

describe("default Phase 0 capability report", () => {
  it("constructs the production reader service and exposes the reader surface", async () => {
    const closeReader = vi.fn(async () => undefined);
    const service = {
      listRoots: vi.fn(async () => []),
      listDocuments: vi.fn(async () => []),
      openDocument: vi.fn(async () => ({})),
      readSource: vi.fn(async () => ({})),
      captureSessionBinding: vi.fn(() => ({ status: "unavailable" })),
      createSessionFromBinding: vi.fn(async () => ({})),
      authorizeAccess: vi.fn(async () => undefined),
      startQuestion: vi.fn(async () => ({})),
      pollQuestion: vi.fn(async () => ({})),
      cancelQuestion: vi.fn(async () => undefined),
      setDisposition: vi.fn(async () => undefined),
      preparePatch: vi.fn(async () => ({})),
      approvePatch: vi.fn(async () => ({})),
      writeExplained: vi.fn(async () => ({})),
      close: closeReader,
    };
    const createService = vi.fn(() => service);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const runtime = await startProductionReaderServer({
      probeHtml: `<!doctype html><html lang="en"><title>AIMD probe</title></html>`,
      transport: serverTransport,
      createService,
      createLiveProbe: () => ({
        captureHostContext: () => ({ status: "unavailable" }),
        runProbe: async () => createDefaultCapabilityProbeReport(),
        close: async () => undefined,
      }),
    });
    const client = new Client({ name: "aimd-production-index-test", version: "1.0.0" });
    try {
      await client.connect(clientTransport);
      const tools = await client.listTools();
      expect(tools.tools.map(({ name }) => name)).toContain("aimd_open_reader");
      const resource = await client.readResource({ uri: "ui://aimd/reader.html" });
      expect(resource.contents[0]).toMatchObject({
        uri: "ui://aimd/reader.html",
        mimeType: "text/html;profile=mcp-app",
        text: expect.stringContaining("AIMD Reader"),
      });
    } finally {
      await client.close();
      await runtime.close();
    }
    expect(createService).toHaveBeenCalledTimes(1);
    expect(closeReader).toHaveBeenCalledTimes(1);
  });

  it("starts the full reader MCP surface and closes reader work with the server", async () => {
    const report = createDefaultCapabilityProbeReport();
    const closeLiveProbe = vi.fn(async () => undefined);
    const closeReader = vi.fn(async () => undefined);
    const service = {
      listRoots: vi.fn(async () => []),
      listDocuments: vi.fn(async () => []),
      openDocument: vi.fn(async () => ({})),
      readSource: vi.fn(async () => ({})),
      captureSessionBinding: vi.fn(() => ({ status: "unavailable" })),
      createSessionFromBinding: vi.fn(async () => ({})),
      authorizeAccess: vi.fn(async () => undefined),
      startQuestion: vi.fn(async () => ({})),
      pollQuestion: vi.fn(async () => ({})),
      cancelQuestion: vi.fn(async () => undefined),
      setDisposition: vi.fn(async () => undefined),
      preparePatch: vi.fn(async () => ({})),
      approvePatch: vi.fn(async () => ({})),
      writeExplained: vi.fn(async () => ({})),
      close: closeReader,
    };
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const runtime = await startReaderServer({
      probeHtml: '<!doctype html><html lang="en"><title>AIMD probe</title></html>',
      readerHtml: "<!doctype html><html><title>AIMD Reader</title></html>",
      service,
      transport: serverTransport,
      createLiveProbe: () => ({
        captureHostContext: () => ({ status: "unavailable" }),
        runProbe: async () => report,
        close: closeLiveProbe,
      }),
    });
    const client = new Client({ name: "aimd-reader-index-test", version: "1.0.0" });

    try {
      await client.connect(clientTransport);
      const tools = await client.listTools();
      expect(tools.tools.map(({ name }) => name)).toContain("aimd_open_reader");
      const resource = await client.readResource({ uri: "ui://aimd/reader.html" });
      expect(resource.contents[0]).toMatchObject({
        uri: "ui://aimd/reader.html",
        mimeType: "text/html;profile=mcp-app",
      });
    } finally {
      await client.close();
      await vi.waitFor(() => {
        expect(closeReader).toHaveBeenCalledTimes(1);
        expect(closeLiveProbe).toHaveBeenCalledTimes(1);
      });
      const first = runtime.close();
      expect(runtime.close()).toBe(first);
      await first;
    }
    expect(closeReader).toHaveBeenCalledTimes(1);
    expect(closeLiveProbe).toHaveBeenCalledTimes(1);
  });

  it("recovers interrupted reader runs before accepting the transport", async () => {
    const order: string[] = [];
    const report = createDefaultCapabilityProbeReport();
    const recoverInterruptedRuns = vi.fn(async () => {
      order.push("recover");
      return 0;
    });
    const service = {
      listRoots: vi.fn(async () => []),
      listDocuments: vi.fn(async () => []),
      openDocument: vi.fn(async () => ({})),
      readSource: vi.fn(async () => ({})),
      captureSessionBinding: vi.fn(() => ({ status: "unavailable" })),
      createSessionFromBinding: vi.fn(async () => ({})),
      authorizeAccess: vi.fn(async () => undefined),
      startQuestion: vi.fn(async () => ({})),
      pollQuestion: vi.fn(async () => ({})),
      cancelQuestion: vi.fn(async () => undefined),
      setDisposition: vi.fn(async () => undefined),
      preparePatch: vi.fn(async () => ({})),
      approvePatch: vi.fn(async () => ({})),
      writeExplained: vi.fn(async () => ({})),
      recoverInterruptedRuns,
      close: vi.fn(async () => undefined),
    };
    const [, serverTransport] = InMemoryTransport.createLinkedPair();
    const startTransport = serverTransport.start.bind(serverTransport);
    serverTransport.start = async () => {
      order.push("connect");
      await startTransport();
    };

    const runtime = await startReaderServer({
      probeHtml: '<!doctype html><html lang="en"><title>AIMD probe</title></html>',
      readerHtml: "<!doctype html><html><title>AIMD Reader</title></html>",
      service,
      transport: serverTransport,
      createLiveProbe: () => ({
        captureHostContext: () => ({ status: "unavailable" }),
        runProbe: async () => report,
        close: async () => undefined,
      }),
    });

    expect(order).toEqual(["recover", "connect"]);
    expect(recoverInterruptedRuns).toHaveBeenCalledTimes(1);
    await runtime.close();
  });

  it("closes reader dependencies when startup recovery fails", async () => {
    const report = createDefaultCapabilityProbeReport();
    const closeReader = vi.fn(async () => undefined);
    const closeLiveProbe = vi.fn(async () => undefined);
    const service = {
      listRoots: vi.fn(async () => []),
      listDocuments: vi.fn(async () => []),
      openDocument: vi.fn(async () => ({})),
      readSource: vi.fn(async () => ({})),
      captureSessionBinding: vi.fn(() => ({ status: "unavailable" })),
      createSessionFromBinding: vi.fn(async () => ({})),
      authorizeAccess: vi.fn(async () => undefined),
      startQuestion: vi.fn(async () => ({})),
      pollQuestion: vi.fn(async () => ({})),
      cancelQuestion: vi.fn(async () => undefined),
      setDisposition: vi.fn(async () => undefined),
      preparePatch: vi.fn(async () => ({})),
      approvePatch: vi.fn(async () => ({})),
      writeExplained: vi.fn(async () => ({})),
      recoverInterruptedRuns: vi.fn(async () => {
        throw new Error("recovery failed");
      }),
      close: closeReader,
    };
    const [, serverTransport] = InMemoryTransport.createLinkedPair();
    const startTransport = vi.spyOn(serverTransport, "start");

    await expect(startReaderServer({
      probeHtml: '<!doctype html><html lang="en"><title>AIMD probe</title></html>',
      readerHtml: "<!doctype html><html><title>AIMD Reader</title></html>",
      service,
      transport: serverTransport,
      createLiveProbe: () => ({
        captureHostContext: () => ({ status: "unavailable" }),
        runProbe: async () => report,
        close: closeLiveProbe,
      }),
    })).rejects.toThrow("recovery failed");

    expect(startTransport).not.toHaveBeenCalled();
    expect(closeReader).toHaveBeenCalledTimes(1);
    expect(closeLiveProbe).toHaveBeenCalledTimes(1);
  });

  it("shares dependency cleanup between a disconnect and concurrent explicit closes", async () => {
    const report = createDefaultCapabilityProbeReport();
    let releaseReaderClose!: () => void;
    const readerCloseStarted = new Promise<void>((accept) => {
      releaseReaderClose = accept;
    });
    const closeReader = vi.fn(() => readerCloseStarted);
    const closeLiveProbe = vi.fn(async () => undefined);
    const service = {
      listRoots: vi.fn(async () => []),
      listDocuments: vi.fn(async () => []),
      openDocument: vi.fn(async () => ({})),
      readSource: vi.fn(async () => ({})),
      captureSessionBinding: vi.fn(() => ({ status: "unavailable" })),
      createSessionFromBinding: vi.fn(async () => ({})),
      authorizeAccess: vi.fn(async () => undefined),
      startQuestion: vi.fn(async () => ({})),
      pollQuestion: vi.fn(async () => ({})),
      cancelQuestion: vi.fn(async () => undefined),
      setDisposition: vi.fn(async () => undefined),
      preparePatch: vi.fn(async () => ({})),
      approvePatch: vi.fn(async () => ({})),
      writeExplained: vi.fn(async () => ({})),
      close: closeReader,
    };
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const runtime = await startReaderServer({
      probeHtml: '<!doctype html><html lang="en"><title>AIMD probe</title></html>',
      readerHtml: "<!doctype html><html><title>AIMD Reader</title></html>",
      service,
      transport: serverTransport,
      createLiveProbe: () => ({
        captureHostContext: () => ({ status: "unavailable" }),
        runProbe: async () => report,
        close: closeLiveProbe,
      }),
    });
    const client = new Client({ name: "aimd-reader-close-race", version: "1.0.0" });
    await client.connect(clientTransport);

    await client.close();
    await vi.waitFor(() => expect(closeReader).toHaveBeenCalledTimes(1));
    const first = runtime.close();
    expect(runtime.close()).toBe(first);
    releaseReaderClose();
    await first;

    expect(closeReader).toHaveBeenCalledTimes(1);
    expect(closeLiveProbe).toHaveBeenCalledTimes(1);
  });

  it.each([
    { name: "client rejection", error: new Error("thr_secret C:\\Users\\private") },
    {
      name: "SDK timeout",
      error: Object.assign(new Error("private timeout path"), { code: "RequestTimeout" }),
    },
  ])("bounds roots/list and preserves $name as a sanitized failure", async ({ error }) => {
    const listRoots = vi.fn(async () => Promise.reject(error));
    const failure = listAuthorizedMcpRoots({
      getClientCapabilities: () => ({ roots: {} }),
      listRoots,
    });
    await expect(failure).rejects.toThrow("MCP_ROOTS_LIST_FAILED");
    await expect(failure).rejects.not.toThrow(/thr_secret|Users|private timeout/u);
    expect(listRoots).toHaveBeenCalledWith(undefined, {
      timeout: 5_000,
      maxTotalTimeout: 5_000,
    });
  });

  it("never invents a live host, exact task, fork, or fidelity success", () => {
    const report = createDefaultCapabilityProbeReport();

    expect(report.gates.map((gate) => gate.id)).toEqual(["P0-A", "P0-B", "P0-C", "P0-D", "P0-E"]);
    expect(report.gates.every((gate) => ["not_run", "inconclusive"].includes(gate.status))).toBe(true);
    expect(report.gates).not.toEqual(expect.arrayContaining([expect.objectContaining({ status: "passed" })]));
    expect(report.featureFlags).toEqual({
      task_and_project: false,
      project_only: false,
      reader_only: false,
    });
    expect(report.sourcePeek.excerptHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("routes the packaged default through the production live-probe factory", async () => {
    const report = createDefaultCapabilityProbeReport();
    report.gates[0] = {
      id: "P0-A",
      status: "inconclusive",
      summary: "The resource challenge completed, but host UI provenance was not attested.",
      diagnosticCode: "UI_PROVENANCE_UNATTESTED",
    };
    const captureHostContext = vi.fn(() => ({
      status: "candidate" as const,
      bindingToken: "opaque-index-live",
    }));
    const runProbe = vi.fn(async () => report);
    const closeLiveProbe = vi.fn(async () => undefined);
    let readRoots: ProductionLiveProbeOptions["getMcpRoots"] | undefined;
    const createLiveProbe = vi.fn((options: Pick<
      ProductionLiveProbeOptions,
      "getMcpRoots"
    >): ProductionLiveProbe => {
      readRoots = options.getMcpRoots;
      return { captureHostContext, runProbe, close: closeLiveProbe };
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const runtime = await startProbeServer({
      probeHtml: '<!doctype html><html lang="en" data-aimd-probe-auto-start="true"><title>AIMD live</title></html>',
      transport: serverTransport,
      createLiveProbe,
    });
    const client = new Client({ name: "aimd-live-index-test", version: "1.0.0" });

    try {
      await client.connect(clientTransport);
      expect(await readRoots?.()).toBeUndefined();
      const resource = await client.readResource({ uri: PROBE_RESOURCE_URI });
      const resourceText = resource.contents[0] && "text" in resource.contents[0]
        ? resource.contents[0].text
        : undefined;
      const challenge = typeof resourceText === "string"
        ? /data-aimd-probe-challenge="([A-Za-z0-9_-]+)"/u.exec(resourceText)?.[1]
        : undefined;
      expect(challenge).toBeTruthy();
      const result = await client.callTool({
        name: "aimd_run_capability_probe",
        arguments: {
          challenge,
          sourceHash: report.sourcePeek.excerptHash,
          fullscreenRequested: true,
        },
        _meta: { "openai/threadId": "thr_index_secret" },
      });

      expect(createLiveProbe).toHaveBeenCalledTimes(1);
      expect(captureHostContext).toHaveBeenCalledWith(
        expect.objectContaining({ "openai/threadId": "thr_index_secret" }),
      );
      expect(runProbe).toHaveBeenCalledWith(
        {
          status: "candidate",
          bindingToken: "opaque-index-live",
        },
        { resourceChallengeCompleted: true },
      );
      expect(result.structuredContent).toEqual(report);
      expect(JSON.stringify(result)).not.toContain("thr_index_secret");
    } finally {
      await client.close();
      await runtime.close();
      expect(closeLiveProbe).toHaveBeenCalledTimes(1);
    }
  });

  it("normalizes and preserves a live-probe close rejection at the runtime boundary", async () => {
    const report = createDefaultCapabilityProbeReport();
    const closeLiveProbe = vi.fn(() => Promise.reject(
      new Error("APP_SERVER_CLOSE_TIMEOUT C:\\Users\\private\\secret-codex.exe"),
    ));
    const createLiveProbe = (): ProductionLiveProbe => ({
      captureHostContext: () => ({ status: "unavailable" }),
      runProbe: async () => report,
      close: closeLiveProbe,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const runtime = await startProbeServer({
      probeHtml: '<!doctype html><html lang="en" data-aimd-probe-auto-start="true"><title>AIMD live</title></html>',
      transport: serverTransport,
      createLiveProbe,
    });
    const client = new Client({ name: "aimd-close-index-test", version: "1.0.0" });
    await client.connect(clientTransport);

    const first = runtime.close();
    const second = runtime.close();
    expect(second).toBe(first);
    await expect(first).rejects.toMatchObject({
      code: "PROBE_SERVER_CLOSE_FAILED",
      message: "PROBE_SERVER_CLOSE_FAILED",
    });
    await expect(second).rejects.toMatchObject({
      code: "PROBE_SERVER_CLOSE_FAILED",
      message: "PROBE_SERVER_CLOSE_FAILED",
    });
    expect(closeLiveProbe).toHaveBeenCalledTimes(1);
    expect(String(await first.catch((error: unknown) => (error as Error).message)))
      .not.toMatch(/APP_SERVER_CLOSE_TIMEOUT|Users|secret-codex/u);
    await client.close().catch(() => undefined);
  });

  it("never converts a rejected signal shutdown into an unconditional zero exit", async () => {
    const source = await readFile(new URL("./index.ts", import.meta.url), "utf8");

    expect(source).toContain("const runtime = await startProductionReaderServer({ ...options, readerHtml });");
    expect(source).not.toContain("const runtime = await startProbeServer();");
    expect(source).not.toContain(".finally(() => process.exit(0))");
    expect(source).toContain("SHUTDOWN_FAILED");
    expect(source).toContain("process.exit(1)");
  });
});

describe("portable plugin packaging", () => {
  it("does not collapse case-sensitive Windows directory components", () => {
    expect(packageHelpers.sameCanonicalPath("C:\\Root", "c:\\Root", "win32")).toBe(true);
    expect(packageHelpers.sameCanonicalPath("C:\\Root", "C:\\root", "win32")).toBe(false);
    expect(packageHelpers.isCanonicalPathContained(
      "C:\\Root",
      "C:\\Root\\dist\\server.mjs",
      "win32",
    )).toBe(true);
    expect(packageHelpers.isCanonicalPathContained(
      "C:\\Root",
      "C:\\root\\dist\\server.mjs",
      "win32",
    )).toBe(false);
  });

  it("keeps checked-in plugin artifacts equivalent to a fresh package across checkout line endings", async () => {
    const freshDist = join(pluginRoot, "dist");
    const checkedInDist = join(workspaceRoot, "plugins", "aimd-reader", "dist");
    await expect(readFile(join(checkedInDist, "server.mjs"), "utf8").then(normalizeTextArtifact))
      .resolves.toBe(normalizeTextArtifact(await readFile(join(freshDist, "server.mjs"), "utf8")));
    await expect(readFile(join(checkedInDist, "probe.html"), "utf8").then(normalizeTextArtifact))
      .resolves.toBe(normalizeTextArtifact(await readFile(join(freshDist, "probe.html"), "utf8")));
    await expect(readFile(join(checkedInDist, "reader.html"), "utf8").then(normalizeTextArtifact))
      .resolves.toBe(normalizeTextArtifact(await readFile(join(freshDist, "reader.html"), "utf8")));
    await expect(readFile(join(checkedInDist, "safe-write-windows.ps1")))
      .resolves.toEqual(await readFile(join(freshDist, "safe-write-windows.ps1")));
  });

  it("bundles exactly one server and a self-contained probe without maps or local paths", async () => {
    const dist = join(pluginRoot, "dist");
    expect((await readdir(dist)).sort()).toEqual([
      "probe.html",
      "reader.html",
      "safe-write-windows.ps1",
      "server.mjs",
    ]);

    const server = await readFile(join(dist, "server.mjs"), "utf8");
    const probe = await readFile(join(dist, "probe.html"), "utf8");
    const reader = await readFile(join(dist, "reader.html"), "utf8");
    const helper = await readFile(join(dist, "safe-write-windows.ps1"));
    const helperHash = createHash("sha256").update(helper).digest("hex");
    const sourceHelper = await readFile(join(workspaceRoot, "scripts", "safe-write-windows.ps1"));
    const combined = `${server}\n${probe}\n${reader}`;
    const userProfile = process.env.USERPROFILE;

    expect(server.length).toBeGreaterThan(1_000);
    expect(helper).toEqual(sourceHelper);
    expect(helperHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(server).toContain(helperHash);
    for (const testOnlyIsolationSymbol of [
      "issueModelIsolationAuthorityForTesting",
      "mintModelIsolationAuthorityForTesting",
      "MODEL_ISOLATION_TEST_AUTHORITY_UNAVAILABLE",
    ]) {
      expect(server).not.toContain(testOnlyIsolationSymbol);
    }
    expect(probe).toContain("data-aimd-probe-auto-start=\"true\"");
    expect(probe).toMatch(/<style>[\s\S]+<\/style>/);
    expect(probe).toMatch(/<script>[\s\S]+<\/script>/);
    expect(probe).not.toMatch(/<script[^>]+\bsrc=/i);
    expect(probe).not.toMatch(/<link[^>]+\bhref=/i);
    expect(reader).toContain("向文档提问");
    expect(reader).toContain('lang="zh-CN"');
    expect(reader).toMatch(/<style[^>]*>[\s\S]+<\/style>/);
    expect(reader).toMatch(/<script[^>]*>[\s\S]+<\/script>/);
    expect(reader).not.toMatch(/<script[^>]+\bsrc=/i);
    expect(reader).not.toMatch(/<link[^>]+\bhref=/i);
    expect(combined).not.toContain("sourceMappingURL");
    expect(combined.toLowerCase()).not.toContain(workspaceRoot.toLowerCase());
    expect(() => packageHelpers.assertArtifactHasNoKnownLocalPath(
      helper.toString("utf8"),
      [workspaceRoot, pluginRoot],
    )).not.toThrow();
    if (userProfile) expect(combined.toLowerCase()).not.toContain(userProfile.toLowerCase());
    expect(combined).not.toMatch(/[A-Za-z]:[\\/](?:Users|Project)[\\/]/i);
    expect(await readdir(dist)).not.toEqual(expect.arrayContaining([expect.stringMatching(/\.map$/)]));
    expect((await readdir(pluginRoot)).sort()).toEqual([".codex-plugin", ".mcp.json", "dist"]);
  });

  it("keeps browser bootstrap code out of server.mjs and server process code out of probe.html", async () => {
    const dist = join(pluginRoot, "dist");
    const server = await readFile(join(dist, "server.mjs"), "utf8");
    const probe = await readFile(join(dist, "probe.html"), "utf8");
    const browserOnly = [
      "data-aimd-probe-auto-start",
      "AIMD probe host did not grant fullscreen",
      "globalThis.crypto.subtle",
    ];
    const serverOnly = ["STARTUP_FAILED", "node:fs/promises", ".stdin", ".stdout", "process.stderr"];

    for (const marker of browserOnly) {
      expect(server).not.toContain(marker);
      expect(() => packageHelpers.assertArtifactBoundaries(`${server}${marker}`, probe)).toThrow(/browser-only/i);
    }
    expect(probe).toContain("data-aimd-probe-auto-start");
    expect(probe).toContain("globalThis.crypto.subtle");
    for (const marker of serverOnly) {
      expect(server).toContain(marker);
      expect(probe).not.toContain(marker);
      expect(() => packageHelpers.assertArtifactBoundaries(server, `${probe}${marker}`)).toThrow(/server process/i);
    }
  });

  it("rejects raw, escaped, file-URL, URI, and fully percent-encoded local path leaks", () => {
    const leakedPath = process.platform === "win32"
      ? "Q:\\vault space\\aimd-secret"
      : "/opt/vault space/aimd-secret";
    const slashPath = leakedPath.replaceAll("\\", "/");
    const fileUrl = pathToFileURL(leakedPath).href;
    const fullyEncode = (value: string) => Array.from(Buffer.from(value, "utf8"), (byte) =>
      `%${byte.toString(16).padStart(2, "0")}`).join("");
    const injectedVariants = [
      leakedPath,
      slashPath,
      leakedPath.replaceAll("\\", "\\\\"),
      slashPath.replaceAll("/", "\\/"),
      JSON.stringify(leakedPath),
      fileUrl,
      encodeURI(slashPath),
      encodeURI(fileUrl),
      encodeURIComponent(leakedPath),
      encodeURIComponent(slashPath),
      fullyEncode(leakedPath),
      fullyEncode(slashPath),
      fullyEncode(fileUrl),
    ];

    for (const injected of injectedVariants) {
      expect(
        () => packageHelpers.assertArtifactIsPathClean(`fixture-prefix:${injected}:fixture-suffix`, [leakedPath]),
        `variant should be rejected: ${injected}`,
      ).toThrow(/absolute path/i);
    }
  });

  it("rejects arbitrary Windows drive, UNC, device, and file-URL leaks without a known path hint", () => {
    const rawLeaks = [
      "Z:\\unrelated\\vault\\secret.txt",
      "Y:/outside/workspace/private.key",
      "\\\\fileserver\\private-share\\secret.txt",
      "\\\\fileserver\\private-share",
      "//fileserver/private-share/secret.txt",
      "//fileserver/private-share",
      "\\\\?\\C:\\sensitive\\secret.txt",
      "\\\\.\\pipe\\aimd-secret",
      "\\??\\D:\\device-path\\secret.txt",
      "file:///Q:/unrelated/vault/secret.txt",
      "file://fileserver/private-share/secret.txt",
      "file://fileserver",
    ];
    const fullyEncode = (value: string) => Array.from(Buffer.from(value, "utf8"), (byte) =>
      "%" + byte.toString(16).padStart(2, "0")).join("");
    const unicodeEncode = (value: string) => Array.from(value, (character) =>
      "\\u" + character.charCodeAt(0).toString(16).padStart(4, "0")).join("");

    for (const leak of rawLeaks) {
      const variants = [
        leak,
        JSON.stringify(leak),
        encodeURI(leak),
        encodeURIComponent(leak),
        fullyEncode(leak),
        unicodeEncode(leak),
      ];
      for (const variant of variants) {
        expect(
          () => packageHelpers.assertArtifactIsPathClean("fixture(" + variant + ")", []),
          "unhinted Windows path variant should be rejected: " + variant,
        ).toThrow(/absolute path/i);
      }
    }
  });

  it("does not mistake ordinary bundle syntax and non-file URL schemes for local paths", () => {
    const ordinaryBundle = [
      "const endpoint=\"https://example.test/api/v1\";",
      "const resource=\"app://aimd-reader/document\";",
      "const builtin=\"node:fs/promises\";",
      "const rootSchema=uri.startsWith(\"file://\");",
      "const drivePattern=/[A-Za-z]:[\\\\/]/u;",
      "const uncPattern=/^\\\\\\\\[^\\\\]+\\\\[^\\\\]+/u;",
      "const division=total/count/scale;",
    ].join("\n");

    expect(() => packageHelpers.assertArtifactIsPathClean(ordinaryBundle, [])).not.toThrow();
  });

  it("refuses recursive cleanup when a private package directory contains a reparse escape", async () => {
    const safetyRoot = join(temporaryRoot, "cleanup-safety");
    const plugin = join(safetyRoot, "plugin");
    const outside = join(safetyRoot, "outside");
    await mkdir(plugin, { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, "keep.txt"), "must survive", "utf8");
    const captured = await packageHelpers.createPrivatePackageDirectory(plugin);
    const escape = join(captured.path, "escape");
    await symlink(outside, escape, process.platform === "win32" ? "junction" : "dir");

    await expect(packageHelpers.removePrivatePackageDirectory(captured)).rejects.toThrow(/reparse|symbolic/i);
    expect(await readFile(join(outside, "keep.txt"), "utf8")).toBe("must survive");

    await unlink(escape);
    await packageHelpers.removePrivatePackageDirectory(captured);
  });

  it("refuses cleanup when a private package tree exceeds the audit depth budget", async () => {
    const plugin = join(temporaryRoot, "cleanup-depth-budget", "plugin");
    await mkdir(plugin, { recursive: true });
    const captured = await packageHelpers.createPrivatePackageDirectory(plugin);
    let cursor = captured.path;
    for (let depth = 0; depth < 66; depth += 1) {
      cursor = join(cursor, "d");
      await mkdir(cursor);
    }

    await expect(packageHelpers.removePrivatePackageDirectory(captured))
      .rejects.toThrow(/budget|depth|entries/i);
  });

  it("streams a wide private package tree and enforces the entry budget before cleanup", async () => {
    const source = await readFile(packageScript, "utf8");
    expect(source).toContain("await opendir(path)");
    expect(source).not.toMatch(/await readdir\(path,\s*\{\s*withFileTypes:\s*true\s*\}\)/u);

    const plugin = join(temporaryRoot, "cleanup-entry-budget", "plugin");
    await mkdir(plugin, { recursive: true });
    const captured = await packageHelpers.createPrivatePackageDirectory(plugin);
    await Promise.all(Array.from({ length: 16 }, (_, index) =>
      writeFile(join(captured.path, `entry-${index}.txt`), "bounded", "utf8")));

    await expect(packageHelpers.removePrivatePackageDirectory(captured, {
      maxTreeEntriesForTesting: 8,
    })).rejects.toThrow(/budget|entries/i);
  });

  it("refuses cleanup if a private package directory is replaced at the same path", async () => {
    const plugin = join(temporaryRoot, "cleanup-identity", "plugin");
    await mkdir(plugin, { recursive: true });
    const captured = await packageHelpers.createPrivatePackageDirectory(plugin);
    const displaced = `${captured.path}-displaced`;
    await rename(captured.path, displaced);
    await mkdir(captured.path);
    await writeFile(join(captured.path, "keep.txt"), "replacement survives", "utf8");

    await expect(packageHelpers.removePrivatePackageDirectory(captured)).rejects.toThrow(/identity changed/i);
    expect(await readFile(join(captured.path, "keep.txt"), "utf8")).toBe("replacement survives");

    await rm(captured.path, { recursive: true, force: true });
    await rename(displaced, captured.path);
    await packageHelpers.removePrivatePackageDirectory(captured);
  });

  it("rechecks private-directory identity after tree scan and before recursive removal", async () => {
    const plugin = join(temporaryRoot, "cleanup-post-scan-identity", "plugin");
    await mkdir(plugin, { recursive: true });
    const captured = await packageHelpers.createPrivatePackageDirectory(plugin);
    await writeFile(join(captured.path, "original.txt"), "original tree", "utf8");
    const displaced = captured.path + "-displaced-after-scan";

    await expect(packageHelpers.removePrivatePackageDirectory(captured, {
      afterTreeScan: async () => {
        await rename(captured.path, displaced);
        await mkdir(captured.path);
        await writeFile(join(captured.path, "replacement.txt"), "replacement survives", "utf8");
      },
    })).rejects.toThrow(/identity changed/i);
    await expect(readFile(join(captured.path, "replacement.txt"), "utf8"))
      .resolves.toBe("replacement survives");
    await expect(readFile(join(displaced, "original.txt"), "utf8")).resolves.toBe("original tree");

    await rm(captured.path, { recursive: true, force: true });
    await rename(displaced, captured.path);
    await packageHelpers.removePrivatePackageDirectory(captured);
  });

  it("preserves the last-known-good dist when a competitor claims dist between the two renames", async () => {
    const plugin = join(temporaryRoot, "replace-race", "plugin");
    const targetDist = join(plugin, "dist");
    await mkdir(targetDist, { recursive: true });
    await writeFile(join(targetDist, "last-known-good.txt"), "known good", "utf8");
    const captured = await packageHelpers.createPrivatePackageDirectory(plugin);
    const stagingDist = join(captured.path, "dist");
    await mkdir(stagingDist);
    await writeFile(join(stagingDist, "new-build.txt"), "new build", "utf8");

    await expect(packageHelpers.replacePackageDist({
      privateDirectory: captured,
      stagingDist,
      targetDist,
      afterPreviousMoved: async () => {
        await mkdir(targetDist);
        await writeFile(join(targetDist, "competitor.txt"), "do not delete", "utf8");
      },
    })).rejects.toMatchObject({
      code: "PACKAGE_DIST_CONFLICT",
      preservePrivatePackageDirectory: true,
    });

    await expect(readFile(join(targetDist, "competitor.txt"), "utf8")).resolves.toBe("do not delete");
    await expect(readFile(join(captured.path, "previous-dist", "last-known-good.txt"), "utf8"))
      .resolves.toBe("known good");
  });

  it("marks backup identity mismatch after the first rename as a preservation conflict", async () => {
    const plugin = join(temporaryRoot, "backup-post-rename-race", "plugin");
    const targetDist = join(plugin, "dist");
    await mkdir(targetDist, { recursive: true });
    await writeFile(join(targetDist, "last-known-good.txt"), "known good", "utf8");
    const captured = await packageHelpers.createPrivatePackageDirectory(plugin);
    const stagingDist = join(captured.path, "dist");
    const displacedBackup = join(captured.path, "displaced-last-known-good");
    await mkdir(stagingDist);
    await writeFile(join(stagingDist, "new-build.txt"), "new build", "utf8");

    await expect(packageHelpers.replacePackageDist({
      privateDirectory: captured,
      stagingDist,
      targetDist,
      afterPreviousRename: async () => {
        await rename(join(captured.path, "previous-dist"), displacedBackup);
        await mkdir(join(captured.path, "previous-dist"));
        await writeFile(join(captured.path, "previous-dist", "impostor.txt"), "impostor", "utf8");
      },
    })).rejects.toMatchObject({
      code: "PACKAGE_DIST_CONFLICT",
      preservePrivatePackageDirectory: true,
    });

    await expect(readFile(join(displacedBackup, "last-known-good.txt"), "utf8"))
      .resolves.toBe("known good");
    await expect(readFile(join(captured.path, "previous-dist", "impostor.txt"), "utf8"))
      .resolves.toBe("impostor");
  });

  it("does not let package cleanup delete the preserved backup after a dist install conflict", async () => {
    const plugin = join(temporaryRoot, "package-replace-race", "aimd-reader");
    const targetDist = join(plugin, "dist");
    await mkdir(join(plugin, ".codex-plugin"), { recursive: true });
    await mkdir(targetDist);
    await writeFile(join(targetDist, "last-known-good.txt"), "known good", "utf8");
    await writeFile(
      join(plugin, ".codex-plugin", "plugin.json"),
      JSON.stringify({ name: "aimd-reader", mcpServers: "./.mcp.json" }),
      "utf8",
    );
    await writeFile(
      join(plugin, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          "aimd-reader": { command: "node", cwd: ".", args: ["dist/server.mjs"] },
        },
      }),
      "utf8",
    );

    await expect(packageHelpers.packagePlugin({
      workspaceRoot,
      pluginDir: plugin,
      marketplacePath,
      afterPreviousMoved: async () => {
        await mkdir(targetDist);
        await writeFile(join(targetDist, "competitor.txt"), "do not delete", "utf8");
      },
    })).rejects.toMatchObject({
      code: "PACKAGE_DIST_CONFLICT",
      preservePrivatePackageDirectory: true,
    });

    await expect(readFile(join(targetDist, "competitor.txt"), "utf8")).resolves.toBe("do not delete");
    const recoveryRoots = (await readdir(plugin))
      .filter((entry) => entry.startsWith(".aimd-package-"));
    expect(recoveryRoots).toHaveLength(1);
    await expect(readFile(
      join(plugin, recoveryRoots[0]!, "previous-dist", "last-known-good.txt"),
      "utf8",
    )).resolves.toBe("known good");
  }, 60_000);

  it("keeps the recovery tree when backup identity changes after the first package rename", async () => {
    const plugin = join(temporaryRoot, "package-backup-identity-race", "aimd-reader");
    const targetDist = join(plugin, "dist");
    await mkdir(join(plugin, ".codex-plugin"), { recursive: true });
    await mkdir(targetDist);
    await writeFile(join(targetDist, "last-known-good.txt"), "known good", "utf8");
    await writeFile(
      join(plugin, ".codex-plugin", "plugin.json"),
      JSON.stringify({ name: "aimd-reader", mcpServers: "./.mcp.json" }),
      "utf8",
    );
    await writeFile(
      join(plugin, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          "aimd-reader": { command: "node", cwd: ".", args: ["dist/server.mjs"] },
        },
      }),
      "utf8",
    );

    await expect(packageHelpers.packagePlugin({
      workspaceRoot,
      pluginDir: plugin,
      marketplacePath,
      afterPreviousRename: async () => {
        const recoveryRoot = (await readdir(plugin))
          .find((entry) => entry.startsWith(".aimd-package-"));
        expect(recoveryRoot).toBeDefined();
        const recoveryPath = join(plugin, recoveryRoot!);
        await rename(join(recoveryPath, "previous-dist"), join(recoveryPath, "displaced-last-known-good"));
        await mkdir(join(recoveryPath, "previous-dist"));
        await writeFile(join(recoveryPath, "previous-dist", "impostor.txt"), "impostor", "utf8");
      },
    })).rejects.toMatchObject({
      code: "PACKAGE_DIST_CONFLICT",
      preservePrivatePackageDirectory: true,
    });

    const recoveryRoots = (await readdir(plugin))
      .filter((entry) => entry.startsWith(".aimd-package-"));
    expect(recoveryRoots).toHaveLength(1);
    const recoveryPath = join(plugin, recoveryRoots[0]!);
    await expect(readFile(join(recoveryPath, "displaced-last-known-good", "last-known-good.txt"), "utf8"))
      .resolves.toBe("known good");
    await expect(readFile(join(recoveryPath, "previous-dist", "impostor.txt"), "utf8"))
      .resolves.toBe("impostor");
  }, 60_000);

  it("requires .agents by default and accepts .agents-hold only through an explicit test path", async () => {
    const fixture = join(temporaryRoot, "marketplace-default");
    const manifestRoot = join(fixture, "plugins", "aimd-reader", ".codex-plugin");
    const heldMarketplace = join(fixture, ".agents-hold", "plugins", "marketplace.json");
    await mkdir(manifestRoot, { recursive: true });
    await mkdir(dirname(heldMarketplace), { recursive: true });
    await writeFile(join(manifestRoot, "plugin.json"), JSON.stringify({ name: "aimd-reader" }), "utf8");
    await writeFile(heldMarketplace, await readFile(marketplacePath, "utf8"), "utf8");

    await expect(packageHelpers.validateMarketplaceConfig(fixture)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(packageHelpers.validateMarketplaceConfig(fixture, heldMarketplace)).resolves.toMatchObject({
      marketplacePath: heldMarketplace,
    });
  });

  it("validates that .mcp.json resolves exactly to the bundled sibling server", async () => {
    const launch = JSON.parse(await readFile(join(pluginRoot, ".mcp.json"), "utf8")) as {
      mcpServers: Record<string, { command: string; cwd: string; args: string[] }>;
    };
    expect(launch.mcpServers["aimd-reader"]).toEqual({
      command: "node",
      cwd: ".",
      args: ["dist/server.mjs"],
    });
    expect(resolve(pluginRoot, launch.mcpServers["aimd-reader"]!.cwd, launch.mcpServers["aimd-reader"]!.args[0]!))
      .toBe(join(pluginRoot, "dist", "server.mjs"));
  });

  it("rejects extra MCP servers, launch fields, top-level fields, and manifest indirection", async () => {
    const fixture = join(temporaryRoot, "launch-config-exact", "aimd-reader");
    const manifestPath = join(fixture, ".codex-plugin", "plugin.json");
    const launchPath = join(fixture, ".mcp.json");
    const exactLaunch = {
      mcpServers: {
        "aimd-reader": { command: "node", cwd: ".", args: ["dist/server.mjs"] },
      },
    };
    await mkdir(dirname(manifestPath), { recursive: true });
    await writeFile(manifestPath, JSON.stringify({ name: "aimd-reader", mcpServers: "./.mcp.json" }), "utf8");
    await writeFile(launchPath, JSON.stringify(exactLaunch), "utf8");
    await expect(packageHelpers.validatePluginLaunchConfig(fixture))
      .resolves.toBe(join(fixture, "dist", "server.mjs"));

    const invalidLaunches = [
      { ...exactLaunch, unexpected: true },
      {
        mcpServers: {
          ...exactLaunch.mcpServers,
          attacker: { command: "node", cwd: ".", args: ["attacker.mjs"] },
        },
      },
      {
        mcpServers: {
          "aimd-reader": {
            ...exactLaunch.mcpServers["aimd-reader"],
            env: { AIMD_SECRET: "forwarded" },
          },
        },
      },
    ];
    for (const invalid of invalidLaunches) {
      await writeFile(launchPath, JSON.stringify(invalid), "utf8");
      await expect(packageHelpers.validatePluginLaunchConfig(fixture)).rejects.toThrow(/exactly/i);
    }

    await writeFile(launchPath, JSON.stringify(exactLaunch), "utf8");
    for (const mcpServers of [".mcp.json", "./nested/../.mcp.json", ["./.mcp.json"]]) {
      await writeFile(manifestPath, JSON.stringify({ name: "aimd-reader", mcpServers }), "utf8");
      await expect(packageHelpers.validatePluginLaunchConfig(fixture)).rejects.toThrow(/manifest|\.\/\.mcp\.json/i);
    }
  });
});

type JsonRpcMessage = {
  readonly jsonrpc: "2.0";
  readonly id?: number | string;
  readonly method?: string;
  readonly result?: unknown;
  readonly error?: unknown;
};

function startProtocolProcess(
  serverPath: string,
  secret: string,
  options: {
    readonly roots?: readonly { readonly uri: string; readonly name?: string }[];
    readonly environment?: Readonly<Record<string, string>>;
  } = {},
) {
  const child = spawn(process.execPath, [serverPath], {
    cwd: dirname(serverPath),
    env: { ...process.env, AIMD_TEST_SECRET: secret, ...options.environment },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const messages: JsonRpcMessage[] = [];
  const rawLines: string[] = [];
  const stderr: Buffer[] = [];
  let pending = "";
  let parseFailure: unknown;

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    pending += chunk;
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? "";
    for (const line of lines) {
      if (!line) continue;
      rawLines.push(line);
      try {
        const message = JSON.parse(line) as JsonRpcMessage;
        if (message.method === "roots/list" && message.id !== undefined) {
          child.stdin.write(`${JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            result: { roots: options.roots ?? [] },
          })}\n`);
        } else {
          messages.push(message);
        }
      } catch (error) {
        parseFailure = error;
      }
    }
  });
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));

  return {
    child,
    messages,
    rawLines,
    stderr,
    getParseFailure: () => parseFailure,
    getPendingOutput: () => pending,
  };
}

function send(child: ChildProcessWithoutNullStreams, message: unknown): void {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

async function waitForResponse(messages: JsonRpcMessage[], id: number): Promise<JsonRpcMessage> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 10_000) {
    const response = messages.find((message) => message.id === id);
    if (response) return response;
    await new Promise((accept) => setTimeout(accept, 10));
  }
  throw new Error(`Timed out waiting for JSON-RPC response ${id}`);
}

async function stop(child: ChildProcessWithoutNullStreams): Promise<number | null> {
  // Closing the stdio transport is portable on Windows, where child.kill()
  // reports a terminated signal even when a process installs SIGTERM hooks.
  child.stdin.end();
  return await Promise.race([
    new Promise<number | null>((accept) => child.once("exit", accept)),
    new Promise<never>((_accept, reject) => setTimeout(() => reject(new Error("stdio server did not stop")), 10_000)),
  ]);
}

describe("stdio entry point", () => {
  it("survives relocation and emits only newline-delimited JSON-RPC on stdout", async () => {
    const relocated = join(temporaryRoot, "relocated", "aimd-reader");
    await mkdir(dirname(relocated), { recursive: true });
    await rename(pluginRoot, relocated);
    pluginRoot = relocated;

    const secret = "secret-shaped-value-must-never-be-forwarded";
    const protocol = startProtocolProcess(join(pluginRoot, "dist", "server.mjs"), secret);
    let stopped = false;
    try {
      send(protocol.child, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "aimd-package-test", version: "1.0.0" },
      },
    });
    const initialized = await waitForResponse(protocol.messages, 1);
    expect(initialized.error).toBeUndefined();
    send(protocol.child, { jsonrpc: "2.0", method: "notifications/initialized", params: {} });
    send(protocol.child, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    const tools = await waitForResponse(protocol.messages, 2);
    expect(tools.error).toBeUndefined();
    expect(JSON.stringify(tools.result)).toContain("aimd_run_capability_probe");
    expect(JSON.stringify(tools.result)).toContain("aimd_open_reader");

    send(protocol.child, {
      jsonrpc: "2.0",
      id: 3,
      method: "resources/read",
      params: { uri: PROBE_RESOURCE_URI },
    });
      const probeResource = await waitForResponse(protocol.messages, 3);
      expect(probeResource.error).toBeUndefined();
      const probeContents = (probeResource.result as {
        contents?: readonly { text?: string }[];
      }).contents;
      const probeHtml = probeContents?.[0]?.text;
      const challenge = typeof probeHtml === "string"
        ? /data-aimd-probe-challenge="([A-Za-z0-9_-]+)"/u.exec(probeHtml)?.[1]
        : undefined;
      expect(challenge).toBeTruthy();

    send(protocol.child, {
      jsonrpc: "2.0",
      id: 4,
      method: "resources/read",
      params: { uri: PROBE_SOURCE_URI },
    });
      const sourceResource = await waitForResponse(protocol.messages, 4);
      expect(sourceResource.error).toBeUndefined();
      const sourceContents = (sourceResource.result as {
        contents?: readonly { text?: string }[];
      }).contents;
      const sourceText = sourceContents?.[0]?.text;
      expect(typeof sourceText).toBe("string");

    send(protocol.child, {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: {
        name: "aimd_run_capability_probe",
        arguments: {
          challenge,
          sourceHash: sha256Text(sourceText ?? ""),
          fullscreenRequested: true,
        },
      },
    });
      const probe = await waitForResponse(protocol.messages, 5);
      expect(probe.error).toBeUndefined();
      const structured = (probe.result as { structuredContent?: unknown }).structuredContent;
      const report = parseCapabilityProbeReport(structured);
      expect(report.gates[0]).toMatchObject({
        id: "P0-A",
        status: "inconclusive",
        diagnosticCode: "UI_PROVENANCE_UNATTESTED",
      });
      expect(report.gates.slice(1).every((gate) => gate.status !== "passed")).toBe(true);
      expect(report.featureFlags).toEqual({
        task_and_project: false,
        project_only: false,
        reader_only: false,
      });

      expect(await stop(protocol.child)).toBe(0);
      stopped = true;
      expect(protocol.getParseFailure()).toBeUndefined();
      expect(protocol.getPendingOutput()).toBe("");
      expect(protocol.rawLines.length).toBeGreaterThanOrEqual(5);
      expect(protocol.rawLines.every((line) => (JSON.parse(line) as JsonRpcMessage).jsonrpc === "2.0")).toBe(true);
      const allOutput = `${protocol.rawLines.join("\n")}\n${Buffer.concat(protocol.stderr).toString("utf8")}`;
      expect(allOutput).not.toContain(secret);
      expect(Buffer.concat(protocol.stderr).toString("utf8")).toBe("");
    } finally {
      if (!stopped && protocol.child.exitCode === null) {
        await stop(protocol.child).catch(() => undefined);
      }
    }
  }, 30_000);

  it("discards real App Server transport stderr and closes the child through the packaged SIGTERM path", async () => {
    const fixture = join(temporaryRoot, "packaged-sigterm-runtime");
    const project = join(fixture, "project");
    const data = join(fixture, "data");
    const helperPath = join(fixture, "production-entry.mjs");
    const fakeAppServerPath = join(fixture, "app-server");
    const readyPath = join(fixture, "app-server-ready.txt");
    const pidPath = join(fixture, "app-server-pid.txt");
    const closedPath = join(fixture, "app-server-closed.txt");
    const triggerPath = join(fixture, "windows-sigterm-trigger.txt");
    await mkdir(project, { recursive: true });
    await mkdir(data, { recursive: true });
    await writeFile(join(project, "README.md"), "# Packaged lifecycle\n", "utf8");
    await writeFile(fakeAppServerPath, `
const { writeFileSync } = require("node:fs");
writeFileSync(process.env.AIMD_READY_PATH, "ready", "utf8");
writeFileSync(process.env.AIMD_PID_PATH, String(process.pid), "utf8");
process.stderr.write(process.env.AIMD_TEST_SECRET ?? "");
process.stdin.resume();
setInterval(() => {}, 1000);
`, "utf8");
    await writeFile(helperPath, `
import { access, writeFile } from "node:fs/promises";

const bundle = await import(process.env.AIMD_BUNDLE_URL);
const connectBridge = bundle.createProductionBridgeConnector({
  resolveExecutable: async () => ({
    status: "resolved",
    source: "environment",
    executablePath: process.execPath,
    executableBasename: process.platform === "win32" ? "node.exe" : "node",
    version: bundle.PRODUCTION_APP_SERVER_SCHEMA_VERSION,
    desktopCompatibility: "not_provided",
    trust: "operator_explicit",
    exactContextEligible: true,
  }),
});
const service = bundle.createProductionReaderService({
  userDataBaseDir: process.env.AIMD_DATA_ROOT,
  connectBridge: async (input) => {
    const runtime = await connectBridge(input);
    return {
      ...runtime,
      close: async () => {
        await runtime.close();
        await writeFile(process.env.AIMD_CLOSED_PATH, "closed", "utf8");
      },
    };
  },
  writer: {
    capability: async () => ({ status: "unavailable", code: "SAFE_WRITE_UNAVAILABLE" }),
    createExplainedSibling: async () => { throw new Error("SAFE_WRITE_UNAVAILABLE"); },
  },
});

await bundle.runProductionReaderMain({ createService: () => service });
if (process.platform === "win32") {
  setInterval(async () => {
    try {
      await access(process.env.AIMD_SIGTERM_TRIGGER);
      process.emit("SIGTERM");
    } catch {}
  }, 20);
}
`, "utf8");

    const secret = "sigterm-secret-must-never-be-forwarded";
    const protocol = startProtocolProcess(helperPath, secret, {
      roots: [{ uri: pathToFileURL(project).href, name: "packaged-lifecycle" }],
      environment: {
        AIMD_BUNDLE_URL: pathToFileURL(join(pluginRoot, "dist", "server.mjs")).href,
        AIMD_DATA_ROOT: data,
        AIMD_READY_PATH: readyPath,
        AIMD_PID_PATH: pidPath,
        AIMD_CLOSED_PATH: closedPath,
        AIMD_SIGTERM_TRIGGER: triggerPath,
      },
    });
    try {
      send(protocol.child, {
        jsonrpc: "2.0",
        id: 101,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: { roots: { listChanged: false } },
          clientInfo: { name: "aimd-sigterm-test", version: "1.0.0" },
        },
      });
      expect((await waitForResponse(protocol.messages, 101)).error).toBeUndefined();
      send(protocol.child, { jsonrpc: "2.0", method: "notifications/initialized", params: {} });
      send(protocol.child, {
        jsonrpc: "2.0",
        id: 102,
        method: "tools/call",
        params: { name: "aimd_list_roots", arguments: {} },
      });
      const listed = await waitForResponse(protocol.messages, 102);
      expect(listed.error).toBeUndefined();
      const structured = (listed.result as {
        structuredContent?: { roots?: readonly { rootId?: string }[] };
      }).structuredContent;
      const rootId = structured?.roots?.[0]?.rootId;
      expect(rootId).toBeTruthy();
      send(protocol.child, {
        jsonrpc: "2.0",
        id: 103,
        method: "tools/call",
        params: { name: "aimd_list_documents", arguments: { rootId } },
      });
      expect((await waitForResponse(protocol.messages, 103)).error).toBeUndefined();
      await vi.waitFor(
        async () => {
          await expect(access(readyPath)).resolves.toBeUndefined();
        },
        { timeout: 10_000, interval: 20 },
      );

      const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((accept, reject) => {
        protocol.child.once("error", reject);
        protocol.child.once("exit", (code, signal) => accept({ code, signal }));
      });
      if (process.platform === "win32") {
        await writeFile(triggerPath, "SIGTERM", "utf8");
      } else {
        expect(protocol.child.kill("SIGTERM")).toBe(true);
      }
      const result = await Promise.race([
        exited,
        new Promise<never>((_accept, reject) =>
          setTimeout(() => reject(new Error("stdio server ignored SIGTERM")), 10_000)),
      ]);
      expect(result).toEqual({ code: 0, signal: null });
      await expect(readFile(closedPath, "utf8")).resolves.toBe("closed");
      const appServerPid = Number.parseInt(await readFile(pidPath, "utf8"), 10);
      expect(() => process.kill(appServerPid, 0)).toThrow();
      expect(protocol.getParseFailure()).toBeUndefined();
      expect(protocol.rawLines.every((line) => (JSON.parse(line) as JsonRpcMessage).jsonrpc === "2.0"))
        .toBe(true);
      const allOutput = `${protocol.rawLines.join("\n")}\n${Buffer.concat(protocol.stderr).toString("utf8")}`;
      expect(allOutput).not.toContain(secret);
    } finally {
      if (protocol.child.exitCode === null && protocol.child.signalCode === null) {
        await stop(protocol.child).catch(() => undefined);
      }
    }
  }, 30_000);
});
