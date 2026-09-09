import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, realpath, rm, stat, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { LocalSideRuntime } from "../packages/app-server-bridge/src/local-side-runtime.js";
import { createSideQuestionService } from "../packages/workspace-server/src/side-question-service.js";
import { createSideQuestionApi } from "../packages/workspace-server/src/side-question-api.js";
import { createArchitectureApi } from "../packages/workspace-server/src/architecture-api.js";
import { configureLocalWebProxy } from "../packages/workspace-server/src/local-web-network.js";
import { createArchitectureService } from "../packages/workspace-server/src/architecture-service.js";
import { resolveWorkspaceRoot } from "../packages/workspace-server/src/root-resolver.js";
import { openReadOnlyWorkspace } from "../packages/workspace-server/src/workspace.js";

declare const ARKI_PACKAGED: boolean;

import { CodexCliRunner, resolveCodexCliExecutable } from "../packages/workspace-server/src/codex-cli-runner.js";
import { createCodexCliBridge } from "../packages/workspace-server/src/codex-cli-bridge.js";
import { createLocalWebReaderApi } from "../packages/workspace-server/src/web-gateway.js";
import { createProductionReaderService } from "../packages/workspace-server/src/production-reader.js";
import { sha256Text } from "../packages/reader-core/src/index.js";
import { ARKI_VERSION } from "../packages/contracts/src/release.js";
import { createUpdateApi } from "../packages/workspace-server/src/update-check.js";

type StartOptions = Readonly<{
  projectRoot: string;
  port: number;
  codexExecutable?: string;
}>;

function argumentValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`Missing value for ${name}`);
  return value;
}

function parseOptions(): StartOptions {
  const projectRoot = resolve(argumentValue("--root") ?? process.cwd());
  const rawPort = argumentValue("--port") ?? "5173";
  const port = Number(rawPort);
  if (!Number.isSafeInteger(port) || port < 1_024 || port > 65_535) {
    throw new Error("Port must be an integer between 1024 and 65535");
  }
  const codexExecutable = argumentValue("--codex");
  if (codexExecutable !== undefined && !isAbsolute(codexExecutable)) {
    throw new Error("--codex must be an absolute native executable path");
  }
  return {
    projectRoot,
    port,
    ...(codexExecutable === undefined ? {} : { codexExecutable }),
  };
}

async function main(): Promise<void> {
  const options = parseOptions();
  const proxySource = configureLocalWebProxy();
  process.stdout.write(`[aimd-network] proxySource=${proxySource}\n`);
  const projectRoot = await realpath(options.projectRoot);
  const projectKey = createHash("sha256").update("aimd-web-collection-v1\0").update(projectRoot).digest("hex");
  const instanceId = randomUUID();
  if (!(await stat(projectRoot)).isDirectory()) throw new Error("Project root is not a directory");
  const codexExecutable = await resolveCodexCliExecutable(options.codexExecutable);
  const sideRoot = await resolveWorkspaceRoot({ mcpRoots: [{ uri: pathToFileURL(projectRoot).href }] });
  if (sideRoot.status !== "verified") throw new Error("SIDE_WORKSPACE_UNAVAILABLE");
  const sideWorkspace = await openReadOnlyWorkspace(sideRoot.rootBinding);
  const sideRuntime = new LocalSideRuntime({ executablePath: codexExecutable, projectRoot });
  const sideApi = createSideQuestionApi(createSideQuestionService({ workspace: sideWorkspace, runtime: sideRuntime }), { onError: failure => process.stderr.write(`[aimd-side] ${JSON.stringify(failure)}\n`) });
  const stateBase = await mkdtemp(join(tmpdir(), "aimd-web-state-"));
  const runner = new CodexCliRunner({ executablePath: codexExecutable });
  const architectureApi = createArchitectureApi(createArchitectureService({ workspace: sideWorkspace, runner }), { projectKey, onError: failure => process.stderr.write(`[aimd-architecture] ${JSON.stringify(failure)}\n`) });
  const service = createProductionReaderService({
    environment: {},
    userDataBaseDir: stateBase,
    connectBridge: async (input) => ({
      bridge: createCodexCliBridge({
        canonicalRoot: input.canonicalRoot,
        rootId: input.workspaceSnapshot.publicSnapshot.rootId,
        workspaceLabel: input.workspaceLabel,
        runner,
        onRunStart: ({ runId, question, runnerName }) => {
          process.stdout.write(
            `[aimd-web] ${runnerName} started ${runId}; question-sha256=${sha256Text(question)}; chars=${question.length}\n`,
          );
        },
        onRunFinish: ({ runId, status, code }) => {
          process.stdout.write(
            `[aimd-web] codex-cli ${status} ${runId}${code === undefined ? "" : `; code=${code}`}\n`,
          );
        },
      }),
      resolveTaskWorkspace: async () => ({ status: "unavailable" }),
      close: async () => undefined,
    }),
  });
  const api = createLocalWebReaderApi({ projectRoot, service });
  const updateApi = createUpdateApi();
  const sourceRoot = dirname(fileURLToPath(import.meta.url));
  const uiRoot = resolve(sourceRoot, "..", "apps", "reader-ui");
  const vite = typeof ARKI_PACKAGED !== "undefined" && ARKI_PACKAGED ? null : await (await import("vite")).createServer({ root: uiRoot, configFile: join(uiRoot, "vite.config.ts"), appType: "mpa", server: { middlewareMode: true } });
  const webRoot = fileURLToPath(new URL("./web/", import.meta.url));
  const server = createServer({ requestTimeout: 30000, headersTimeout: 15000 }, (request, response) => {
    if (request.url?.split("?", 1)[0] === "/api/health" && request.method === "GET") {
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify({ ok: true, product: "arki", version: ARKI_VERSION, projectKey, instanceId, backend: "codex-cli", contextMode: "project_only" })); return;
    }
    void updateApi.handle(request, response).then(handled => handled || architectureApi.handle(request, response)).then(handled => handled || sideApi.handle(request, response)).then(handled => handled || api.handle(request, response)).then((handled) => {
      if (handled) return;
      if (vite) { vite.middlewares(request, response, () => { if (!response.headersSent) response.writeHead(404).end("Not found"); }); return; }
      const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
      const file = pathname === "/" || pathname === "/web.html" ? "web.html" : pathname === "/arki-sw.js" ? "arki-sw.js" : null;
      if (request.method !== "GET" || !file) { response.writeHead(404).end("Not found"); return; }
      return readFile(join(webRoot, file)).then(body => response.writeHead(200, { "content-type": file.endsWith(".js") ? "text/javascript;charset=utf-8" : "text/html;charset=utf-8", "cache-control": "no-cache", "x-content-type-options": "nosniff" }).end(body));
    }).catch(() => {
      if (!response.headersSent) {
        response.writeHead(500, { "content-type": "application/json; charset=utf-8" })
          .end(JSON.stringify({ isError: true, structuredContent: { error: { code: "READER_OPERATION_FAILED" } } }));
      }
    });
  });
  try { await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(options.port, "127.0.0.1", () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  }); } catch (error) {
    await Promise.allSettled([vite?.close(), service.close(), sideRuntime.close()]);
    await rm(stateBase, { recursive: true, force: true });
    throw error;
  }

  process.stdout.write(`[arki] Local project workspace: http://127.0.0.1:${options.port}/web.html\n`);
  process.stdout.write(`[aimd-web] project root: ${projectRoot}\n`);
  process.stdout.write(`[aimd-web] codex executable: ${codexExecutable}\n`);

  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    const serverClosed = new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    const forceClose = setTimeout(() => server.closeAllConnections(), 5000); forceClose.unref();
    try { await Promise.allSettled([serverClosed, vite?.close(), service.close(), sideRuntime.close()]); }
    finally { clearTimeout(forceClose); }
    await rm(stateBase, { recursive: true, force: true });
  };
  const shutdown = () => {
    void close().then(() => process.exit(0), () => process.exit(1));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "unknown startup error";
  process.stderr.write(`[aimd-web] startup failed: ${message}\n`);
  process.exitCode = 1;
});
