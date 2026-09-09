import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { sha256Text } from "@aimd/reader-core";

import {
  CapabilityProbeReportSchema,
  PROBE_SOURCE_TEXT,
  PROBE_SOURCE_URI,
  createProbeMcpServer,
  createReaderMcpServer,
  type CapabilityProbeReport,
  type ProbeMcpDependencies,
  type ReaderMcpService,
} from "./mcp.js";
import {
  createProductionLiveProbe,
  type ProductionLiveProbe,
  type ProductionLiveProbeOptions,
} from "./live-probe.js";
import {
  createProductionReaderService,
} from "./production-reader.js";

export * from "./canonical-path.js";
export * from "./codex-cli-bridge.js";
export * from "./codex-cli-runner.js";
export * from "./config.js";
export * from "./model-sandbox.js";
export * from "./path-guard.js";
export * from "./production-reader.js";
export * from "./root-resolver.js";
export * from "./safe-writer.js";
export * from "./service.js";
export * from "./store.js";
export * from "./web-gateway.js";
export * from "./workspace.js";

export type ProbeServerRuntime = {
  readonly close: () => Promise<void>;
};

export class ProbeServerShutdownError extends Error {
  readonly code = "PROBE_SERVER_CLOSE_FAILED";

  constructor() {
    super("PROBE_SERVER_CLOSE_FAILED");
    this.name = "ProbeServerShutdownError";
  }
}

type McpRootProtocol = {
  readonly getClientCapabilities: () => { readonly roots?: unknown } | undefined;
  readonly listRoots: (
    params?: undefined,
    options?: { readonly timeout?: number; readonly maxTotalTimeout?: number },
  ) => Promise<{ readonly roots: readonly { readonly uri: string }[] }>;
};

const ROOTS_LIST_TIMEOUT_MS = 5_000;

export async function listAuthorizedMcpRoots(
  protocol: McpRootProtocol | undefined,
): Promise<readonly { readonly uri: string }[] | undefined> {
  if (!protocol?.getClientCapabilities()?.roots) return undefined;
  try {
    const result = await protocol.listRoots(undefined, {
      timeout: ROOTS_LIST_TIMEOUT_MS,
      maxTotalTimeout: ROOTS_LIST_TIMEOUT_MS,
    });
    return result.roots.map((root) => ({ uri: root.uri }));
  } catch {
    throw new Error("MCP_ROOTS_LIST_FAILED");
  }
}

export type StartProbeServerOptions = {
  readonly probeHtml?: string;
  readonly captureHostContext?: ProbeMcpDependencies["captureHostContext"];
  readonly runProbe?: ProbeMcpDependencies["runProbe"];
  readonly transport?: Transport;
  /** Test seam; production always uses createProductionLiveProbe. */
  readonly createLiveProbe?: (
    options: Pick<ProductionLiveProbeOptions, "getMcpRoots">,
  ) => ProductionLiveProbe;
};

export type StartReaderServerOptions = StartProbeServerOptions & {
  readonly readerHtml?: string;
  readonly service: ReaderMcpService & {
    readonly recoverInterruptedRuns?: () => Promise<number>;
    readonly close?: () => Promise<void>;
  };
};

export type StartProductionReaderServerOptions = Omit<StartReaderServerOptions, "service"> & {
  /** Test seam; production always assembles createProductionReaderService. */
  readonly createService?: () => ReaderMcpService & { readonly close?: () => Promise<void> };
};

const MINIMAL_READER_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>AIMD Reader</title>
    <style>
      :root { color-scheme: light dark; font: 16px/1.5 system-ui, sans-serif; }
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: Canvas; color: CanvasText; }
      main { max-width: 42rem; padding: 2rem; border: 1px solid color-mix(in srgb, CanvasText 18%, transparent); border-radius: 1rem; }
      h1 { margin-top: 0; font-size: 1.5rem; }
    </style>
  </head>
  <body><main><h1>AIMD Reader</h1><p>The project-aware reader service is ready.</p></main></body>
</html>`;

/**
 * The packaged entry point has no authority to claim a desktop integration was
 * exercised merely because the stdio process started. A live probe may replace
 * this callback only at the explicit host-metadata boundary.
 */
export function createDefaultCapabilityProbeReport(): CapabilityProbeReport {
  return CapabilityProbeReportSchema.parse({
    reportVersion: 1,
    gates: [
      {
        id: "P0-A",
        status: "inconclusive",
        summary: "The browser must complete and verify the MCP Apps loop.",
      },
      {
        id: "P0-B",
        status: "not_run",
        summary: "Exact task binding requires an explicit live host probe.",
      },
      {
        id: "P0-C",
        status: "not_run",
        summary: "Ephemeral fork creation requires an explicit live host probe.",
      },
      {
        id: "P0-D",
        status: "not_run",
        summary: "Context fidelity requires an explicit live fixture probe.",
      },
      {
        id: "P0-E",
        status: "not_run",
        summary: "The complete failure matrix was not run by this entry point.",
      },
    ],
    featureFlags: {
      task_and_project: false,
      project_only: false,
      reader_only: false,
    },
    sourcePeek: {
      uri: PROBE_SOURCE_URI,
      excerptHash: sha256Text(PROBE_SOURCE_TEXT),
    },
  });
}

/** Start the MCP server without writing anything except protocol frames to stdout. */
export async function startProbeServer(options: StartProbeServerOptions = {}): Promise<ProbeServerRuntime> {
  const probeHtml = options.probeHtml ?? await readFile(new URL("./probe.html", import.meta.url), "utf8");
  if ((options.captureHostContext === undefined) !== (options.runProbe === undefined)) {
    throw new Error("PROBE_DEPENDENCY_PAIR_REQUIRED");
  }

  let server: ReturnType<typeof createProbeMcpServer> | undefined;
  const liveProbe = (options.createLiveProbe ?? createProductionLiveProbe)({
    getMcpRoots: async () => {
      return await listAuthorizedMcpRoots(server?.server);
    },
  });
  const captureHostContext = options.captureHostContext ?? liveProbe.captureHostContext;
  const runProbe = options.runProbe ?? liveProbe.runProbe;
  server = createProbeMcpServer({
    probeHtml,
    captureHostContext,
    runProbe,
  });
  const transport = options.transport ?? new StdioServerTransport();
  await server.connect(transport);

  let closePromise: Promise<void> | undefined;
  return {
    close: () => {
      closePromise ??= Promise.allSettled([
        Promise.resolve().then(() => liveProbe.close()),
        Promise.resolve().then(() => server.close()),
      ]).then((results) => {
        if (results.some((result) => result.status === "rejected")) {
          throw new ProbeServerShutdownError();
        }
      });
      return closePromise;
    },
  };
}

/**
 * Starts the complete MCP Apps surface around an already-authorized reader
 * service. Production root, storage, App Server, and writer capabilities are
 * assembled outside this transport boundary; public tool arguments can never
 * select those dependencies.
 */
export async function startReaderServer(options: StartReaderServerOptions): Promise<ProbeServerRuntime> {
  const [probeHtml, readerHtml] = await Promise.all([
    options.probeHtml ?? readFile(new URL("./probe.html", import.meta.url), "utf8"),
    Promise.resolve(options.readerHtml ?? MINIMAL_READER_HTML),
  ]);
  if ((options.captureHostContext === undefined) !== (options.runProbe === undefined)) {
    throw new Error("PROBE_DEPENDENCY_PAIR_REQUIRED");
  }

  let server: ReturnType<typeof createReaderMcpServer> | undefined;
  const liveProbe = (options.createLiveProbe ?? createProductionLiveProbe)({
    getMcpRoots: async () => await listAuthorizedMcpRoots(server?.server),
  });
  let dependencyClosePromise: Promise<void> | undefined;
  const closeDependencies = () => {
    dependencyClosePromise ??= Promise.allSettled([
      Promise.resolve().then(() => options.service.close?.()),
      Promise.resolve().then(() => liveProbe.close()),
    ]).then((results) => {
      if (results.some((result) => result.status === "rejected")) {
        throw new ProbeServerShutdownError();
      }
    });
    return dependencyClosePromise;
  };
  server = createReaderMcpServer({
    probeHtml,
    readerHtml,
    service: options.service,
    captureHostContext: options.captureHostContext ?? liveProbe.captureHostContext,
    runProbe: options.runProbe ?? liveProbe.runProbe,
  });
  server.server.onclose = () => {
    void closeDependencies().catch(() => undefined);
  };
  try {
    await options.service.recoverInterruptedRuns?.();
    await server.connect(options.transport ?? new StdioServerTransport());
  } catch (error) {
    await Promise.allSettled([
      closeDependencies(),
      Promise.resolve().then(() => server.close()),
    ]);
    throw error;
  }

  let closePromise: Promise<void> | undefined;
  return {
    close: () => {
      closePromise ??= Promise.allSettled([
        closeDependencies(),
        Promise.resolve().then(() => server.close()),
      ]).then((results) => {
        if (results.some((result) => result.status === "rejected")) {
          throw new ProbeServerShutdownError();
        }
      });
      return closePromise;
    },
  };
}

/** Assemble the complete production reader before attaching its MCP transport. */
export async function startProductionReaderServer(
  options: StartProductionReaderServerOptions = {},
): Promise<ProbeServerRuntime> {
  const { createService, ...serverOptions } = options;
  const service: ReaderMcpService & { readonly close?: () => Promise<void> } =
    createService?.() ?? createProductionReaderService();
  try {
    return await startReaderServer({ ...serverOptions, service });
  } catch (error) {
    await service.close?.().catch(() => undefined);
    throw error;
  }
}

function isMainModule(): boolean {
  const argument = process.argv[1];
  if (!argument) return false;
  const modulePath = resolve(fileURLToPath(import.meta.url));
  const argumentPath = resolve(argument);
  return process.platform === "win32"
    ? modulePath.toLowerCase() === argumentPath.toLowerCase()
    : modulePath === argumentPath;
}

export async function runProductionReaderMain(
  options: StartProductionReaderServerOptions = {},
): Promise<void> {
  const readerHtml = options.readerHtml ?? await readFile(new URL("./reader.html", import.meta.url), "utf8");
  const runtime = await startProductionReaderServer({ ...options, readerHtml });
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    void runtime.close().then(
      () => process.exit(0),
      () => {
        process.stderr.write('{"component":"aimd-reader","code":"SHUTDOWN_FAILED"}\n');
        process.exit(1);
      },
    );
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

if (isMainModule()) {
  void runProductionReaderMain().catch(() => {
    // Never forward thrown messages: they may contain absolute paths or raw
    // transport data. Keep stderr bounded and machine-recognizable.
    process.stderr.write('{"component":"aimd-reader","code":"STARTUP_FAILED"}\n');
    process.exitCode = 1;
  });
}
