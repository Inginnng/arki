import { mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  ContextBridge,
  SERVER_OWNED_MODEL_POLICY,
  type AppServerEvent,
  type AppServerThread,
  type BridgeAppServerClient,
} from "@aimd/app-server-bridge";

import {
  createProductionLiveProbe,
  type ProductionLiveProbeDependencies,
} from "./live-probe.js";

let temporaryRoot = "";
let projectRoot = "";
let otherRoot = "";
const MODEL_SANDBOX_PATH = process.platform === "win32"
  ? "C:\\Temp\\aimd-model-sandbox-live-test"
  : "/tmp/aimd-model-sandbox-live-test";

beforeAll(async () => {
  temporaryRoot = await mkdtemp(join(tmpdir(), "aimd-live-probe-"));
  projectRoot = join(temporaryRoot, "fixture");
  otherRoot = join(temporaryRoot, "other");
  await Promise.all([
    mkdir(projectRoot, { recursive: true }),
    mkdir(otherRoot, { recursive: true }),
  ]);
});

afterAll(async () => {
  if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
});

function turn(
  id: string,
  status: "completed" | "inProgress" = "completed",
): AppServerThread["turns"][number] {
  return {
    id,
    status,
    items: [],
    startedAt: 1,
    completedAt: status === "completed" ? 2 : null,
  };
}

function parentThread(cwd = projectRoot): AppServerThread {
  return {
    id: "thr_live_secret",
    cwd,
    ephemeral: false,
    forkedFromId: null,
    status: { type: "idle" },
    turns: [turn("turn_completed_secret"), turn("turn_active_secret", "inProgress")],
  };
}

class FakeLiveClient implements BridgeAppServerClient {
  readonly readCalls: string[] = [];
  readonly forkCalls: Array<{
    threadId: string;
    lastTurnId?: string;
    emptyCwd: string;
    developerInstructions: string;
  }> = [];
  readonly projectCalls: string[] = [];
  turnCalls = 0;
  closeCalls = 0;
  parent = parentThread();

  modelIsolationResult() {
    return {
      status: "reader_only" as const,
      code: "MODEL_ISOLATION_UNPROVEN" as const,
      missing: ["effectiveTools.hostAttestation"],
    };
  }

  initialize(): Promise<{ userAgent: string; platformFamily: string; platformOs: string }> {
    return Promise.resolve({
      userAgent: "codex-cli/0.151.0-alpha.7.2",
      platformFamily: "test",
      platformOs: "test",
    });
  }

  readThread(threadId: string): Promise<AppServerThread> {
    this.readCalls.push(threadId);
    return Promise.resolve(this.parent);
  }

  forkEphemeral(input: {
    threadId: string;
    lastTurnId?: string;
    emptyCwd: string;
    developerInstructions: string;
  }): Promise<AppServerThread> {
    this.forkCalls.push(input);
    return Promise.resolve({
      id: "thr_side_secret",
      cwd: input.emptyCwd,
      ephemeral: true,
      forkedFromId: input.threadId,
      status: { type: "idle" },
      turns: [turn("turn_completed_secret")],
    });
  }

  startProjectEphemeralThread(input: {
    emptyCwd: string;
    developerInstructions: string;
  }): Promise<AppServerThread> {
    this.projectCalls.push(input.emptyCwd);
    return Promise.resolve({
      id: "thr_project_secret",
      cwd: input.emptyCwd,
      ephemeral: true,
      forkedFromId: null,
      status: { type: "idle" },
      turns: [],
    });
  }

  async *startTurn(): AsyncIterable<AppServerEvent> {
    this.turnCalls += 1;
    throw new Error("a model turn must not start without isolation proof");
  }

  interruptTurn(): Promise<void> {
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.closeCalls += 1;
    return Promise.resolve();
  }
}

class BlockingInitializeClient extends FakeLiveClient {
  readonly initializeStarted: Promise<void>;
  private markInitializeStarted!: () => void;
  private rejectInitialize!: (error: Error) => void;

  constructor() {
    super();
    this.initializeStarted = new Promise((resolve) => {
      this.markInitializeStarted = resolve;
    });
  }

  override initialize(): Promise<{
    userAgent: string;
    platformFamily: string;
    platformOs: string;
  }> {
    this.markInitializeStarted();
    return new Promise((_resolve, reject) => {
      this.rejectInitialize = reject;
    });
  }

  override close(): Promise<void> {
    this.closeCalls += 1;
    this.rejectInitialize(new Error("thr_close_secret D:\\Private\\close-secret"));
    return Promise.resolve();
  }
}

class FailingCloseClient extends FakeLiveClient {
  readonly initializeStarted: Promise<void>;
  private markInitializeStarted!: () => void;
  private rejectInitialize!: (error: Error) => void;

  constructor() {
    super();
    this.initializeStarted = new Promise((resolve) => {
      this.markInitializeStarted = resolve;
    });
  }

  override initialize(): Promise<{
    userAgent: string;
    platformFamily: string;
    platformOs: string;
  }> {
    this.markInitializeStarted();
    return new Promise((_resolve, reject) => {
      this.rejectInitialize = reject;
    });
  }

  override close(): Promise<void> {
    this.closeCalls += 1;
    this.rejectInitialize(new Error("thr_initialize_secret D:\\Private\\initialize"));
    return Promise.reject(
      new Error("APP_SERVER_CLOSE_TIMEOUT D:\\Private\\secret-codex.exe"),
    );
  }
}

class FailingFinalCloseClient extends FakeLiveClient {
  override close(): Promise<void> {
    this.closeCalls += 1;
    return Promise.reject(
      new Error("APP_SERVER_CLOSE_TIMEOUT D:\\Private\\secret-codex.exe"),
    );
  }
}

class FailingInitializeClient extends FakeLiveClient {
  override initialize(): Promise<never> {
    return Promise.reject(new Error("thr_initialize_secret C:\\Private\\initialize"));
  }
}

class FailingReadClient extends FakeLiveClient {
  override readThread(threadId: string): Promise<AppServerThread> {
    this.readCalls.push(threadId);
    return Promise.reject(new Error("thr_read_secret C:\\Private\\read"));
  }
}

class PendingCloseClient extends FakeLiveClient {
  readonly closeStarted: Promise<void>;
  private markCloseStarted!: () => void;
  private finishClose!: () => void;

  constructor() {
    super();
    this.closeStarted = new Promise((resolve) => {
      this.markCloseStarted = resolve;
    });
  }

  override close(): Promise<void> {
    this.closeCalls += 1;
    this.markCloseStarted();
    return new Promise((resolve) => {
      this.finishClose = resolve;
    });
  }

  resolveClose(): void {
    this.finishClose();
  }
}

function rootUri(root = projectRoot): string {
  return process.platform === "win32"
    ? new URL(`file:///${root.replaceAll("\\", "/")}`).href
    : new URL(`file://${root}`).href;
}

function dependencies(
  client: FakeLiveClient,
  roots: readonly { readonly uri: string }[] | undefined = [{ uri: rootUri() }],
): ProductionLiveProbeDependencies {
  return {
    getMcpRoots: async () => roots,
    resolveExecutable: async () => ({
      status: "resolved",
      source: "verified_host_hint",
      executablePath: process.platform === "win32" ? "C:\\Codex\\codex.exe" : "/opt/codex",
      executableBasename: process.platform === "win32" ? "codex.exe" : "codex",
      version: "0.151.0-alpha.7.2",
      desktopCompatibility: "matched",
    }),
    createClient: () => client,
    createModelSandboxLease: async () => ({
      path: MODEL_SANDBOX_PATH,
      assertTrustedEmpty: async () => {},
      close: async () => {},
    }),
    issueOpaqueId: (() => {
      let sequence = 0;
      return () => `opaque-live-${++sequence}`;
    })(),
  };
}

describe("production live capability probe", () => {
  it("does not start a host probe without server-verified UI attestation", async () => {
    const client = new FakeLiveClient();
    const probe = createProductionLiveProbe(dependencies(client));

    const report = await probe.runProbe(
      { status: "unavailable" },
      { resourceChallengeCompleted: false } as never,
    );

    expect(report.gates[0]).toMatchObject({ id: "P0-A", status: "failed" });
    expect(report.featureFlags.reader_only).toBe(false);
    expect(client.readCalls).toEqual([]);
    expect(client.forkCalls).toEqual([]);
    expect(client.projectCalls).toEqual([]);
  });

  it("closes an active App Server client and rejects new work after shutdown", async () => {
    const client = new BlockingInitializeClient();
    const probe = createProductionLiveProbe(dependencies(client));
    const running = probe.runProbe(
      { status: "unavailable" },
      { resourceChallengeCompleted: true },
    );
    await client.initializeStarted;

    const firstClose = probe.close();
    const secondClose = probe.close();
    expect(secondClose).toBe(firstClose);
    await firstClose;
    const report = await running;
    const afterClose = await probe.runProbe(
      { status: "unavailable" },
      { resourceChallengeCompleted: true },
    );

    expect(client.closeCalls).toBe(1);
    expect(JSON.stringify(report)).not.toMatch(/thr_close_secret|Private|close-secret/u);
    expect(afterClose.gates[1]?.status).not.toBe("passed");
    expect(client.closeCalls).toBe(1);
  });

  it("propagates one fixed close failure while consuming raw active-client errors", async () => {
    const client = new FailingCloseClient();
    const probe = createProductionLiveProbe(dependencies(client));
    const running = probe.runProbe(
      { status: "unavailable" },
      { resourceChallengeCompleted: true },
    );
    const runningOutcome = running.then(
      () => ({ status: "resolved" as const }),
      (error: unknown) => ({
        status: "rejected" as const,
        code: (error as { code?: unknown }).code,
        message: String((error as Error).message),
      }),
    );
    await client.initializeStarted;

    const firstClose = probe.close();
    const secondClose = probe.close();
    expect(secondClose).toBe(firstClose);
    const closeOutcome = await firstClose.then(
      () => ({ status: "resolved" as const }),
      (error: unknown) => ({
        status: "rejected" as const,
        code: (error as { code?: unknown }).code,
        message: String((error as Error).message),
      }),
    );
    const runOutcome = await runningOutcome;

    expect(closeOutcome).toEqual({
      status: "rejected",
      code: "APP_SERVER_CLOSE_FAILED",
      message: "APP_SERVER_CLOSE_FAILED",
    });
    expect(runOutcome).toEqual({
      status: "rejected",
      code: "APP_SERVER_CLOSE_FAILED",
      message: "APP_SERVER_CLOSE_FAILED",
    });
    expect(client.closeCalls).toBe(1);
    expect(JSON.stringify({ closeOutcome, runOutcome }))
      .not.toMatch(/thr_initialize_secret|Private|secret-codex/u);
  });

  it("retains a failed final close for a later global shutdown", async () => {
    const client = new FailingFinalCloseClient();
    const probe = createProductionLiveProbe(dependencies(client));

    const runOutcome = await probe.runProbe(
      { status: "unavailable" },
      { resourceChallengeCompleted: true },
    ).then(
      () => ({ status: "resolved" as const }),
      (error: unknown) => ({
        status: "rejected" as const,
        code: (error as { code?: unknown }).code,
        message: String((error as Error).message),
      }),
    );
    const shutdownOutcome = await probe.close().then(
      () => ({ status: "resolved" as const }),
      (error: unknown) => ({
        status: "rejected" as const,
        code: (error as { code?: unknown }).code,
        message: String((error as Error).message),
      }),
    );

    expect(runOutcome).toEqual({
      status: "rejected",
      code: "APP_SERVER_CLOSE_FAILED",
      message: "APP_SERVER_CLOSE_FAILED",
    });
    expect(shutdownOutcome).toEqual({
      status: "rejected",
      code: "APP_SERVER_CLOSE_FAILED",
      message: "APP_SERVER_CLOSE_FAILED",
    });
    expect(client.closeCalls).toBe(1);
    expect(JSON.stringify({ runOutcome, shutdownOutcome }))
      .not.toMatch(/APP_SERVER_CLOSE_TIMEOUT|Private|secret-codex/u);
  });

  it("waits for every active close before reporting one fixed shutdown failure", async () => {
    const failing = new FailingCloseClient();
    const pending = new PendingCloseClient();
    const clients: FakeLiveClient[] = [failing, pending];
    const probe = createProductionLiveProbe({
      ...dependencies(failing),
      createClient: () => {
        const client = clients.shift();
        if (!client) throw new Error("unexpected extra client");
        return client;
      },
    });
    const firstRun = probe.runProbe(
      { status: "unavailable" },
      { resourceChallengeCompleted: true },
    );
    const firstRunSettled = firstRun.then(() => undefined, () => undefined);
    await failing.initializeStarted;
    const secondRun = probe.runProbe(
      { status: "unavailable" },
      { resourceChallengeCompleted: true },
    );
    const secondRunSettled = secondRun.then(() => undefined, () => undefined);
    await pending.closeStarted;

    let shutdownSettled = false;
    const shutdownOutcome = probe.close().then(
      () => {
        shutdownSettled = true;
        return { status: "resolved" as const };
      },
      (error: unknown) => {
        shutdownSettled = true;
        return {
          status: "rejected" as const,
          code: (error as { code?: unknown }).code,
          message: String((error as Error).message),
        };
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(shutdownSettled).toBe(false);
    pending.resolveClose();
    const outcome = await shutdownOutcome;
    await Promise.all([firstRunSettled, secondRunSettled]);

    expect(outcome).toEqual({
      status: "rejected",
      code: "APP_SERVER_CLOSE_FAILED",
      message: "APP_SERVER_CLOSE_FAILED",
    });
    expect(failing.closeCalls).toBe(1);
    expect(pending.closeCalls).toBe(1);
  });

  it("does not finish shutdown before a run's final client close settles", async () => {
    const client = new PendingCloseClient();
    const probe = createProductionLiveProbe(dependencies(client));
    const running = probe.runProbe(
      { status: "unavailable" },
      { resourceChallengeCompleted: true },
    );
    await client.closeStarted;

    let shutdownSettled = false;
    const shutdown = probe.close().then(() => {
      shutdownSettled = true;
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(shutdownSettled).toBe(false);
    expect(client.closeCalls).toBe(1);

    client.resolveClose();
    await Promise.all([running, shutdown]);
    expect(shutdownSettled).toBe(true);
    expect(client.closeCalls).toBe(1);
  });

  it("waits for an in-flight sandbox factory and closes the late lease before shutdown resolves", async () => {
    const client = new FakeLiveClient();
    let markFactoryStarted!: () => void;
    let resolveLease!: (lease: Awaited<ReturnType<ProductionLiveProbeDependencies["createModelSandboxLease"]>>) => void;
    const factoryStarted = new Promise<void>((resolve) => { markFactoryStarted = resolve; });
    const pendingLease = new Promise<Awaited<ReturnType<ProductionLiveProbeDependencies["createModelSandboxLease"]>>>(
      (resolve) => { resolveLease = resolve; },
    );
    let leaseCloseCalls = 0;
    const base = dependencies(client);
    const probe = createProductionLiveProbe({
      ...base,
      createModelSandboxLease: async () => {
        markFactoryStarted();
        return await pendingLease;
      },
    });
    const running = probe.runProbe(
      { status: "unavailable" },
      { resourceChallengeCompleted: true },
    );
    await factoryStarted;

    let shutdownSettled = false;
    const shutdown = probe.close().then(() => { shutdownSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(shutdownSettled).toBe(false);
    expect(client.closeCalls).toBe(1);

    resolveLease({
      path: MODEL_SANDBOX_PATH,
      assertTrustedEmpty: async () => {},
      close: async () => { leaseCloseCalls += 1; },
    });
    await Promise.all([running, shutdown]);

    expect(shutdownSettled).toBe(true);
    expect(leaseCloseCalls).toBe(1);
    expect(client.closeCalls).toBe(1);
  });

  it("marks candidate initialization failure as failed instead of unsupported", async () => {
    const client = new FailingInitializeClient();
    const probe = createProductionLiveProbe(dependencies(client));
    const binding = probe.captureHostContext({ "openai/threadId": "thr_live_secret" });

    const report = await probe.runProbe(binding, { resourceChallengeCompleted: true });

    expect(report.gates[1]).toMatchObject({
      id: "P0-B",
      status: "failed",
      diagnosticCode: "HOST_CAPABILITY_UNAVAILABLE",
    });
    expect(report.gates[2]?.status).toBe("not_run");
    expect(JSON.stringify(report)).not.toMatch(/thr_initialize_secret|Private|initialize/u);
  });

  it("marks a no-candidate executable resolver exception as failed", async () => {
    const client = new FakeLiveClient();
    const probe = createProductionLiveProbe({
      ...dependencies(client),
      resolveExecutable: async () => {
        throw new Error("resolver transient thr_secret C:\\Private\\resolver");
      },
    });

    const report = await probe.runProbe(
      { status: "unavailable" },
      { resourceChallengeCompleted: true },
    );

    expect(report.gates[1]).toMatchObject({
      id: "P0-B",
      status: "failed",
      diagnosticCode: "HOST_CAPABILITY_UNAVAILABLE",
    });
    expect(JSON.stringify(report)).not.toMatch(/thr_secret|Private|resolver transient/u);
  });

  it("marks a no-candidate client initialization exception as failed", async () => {
    const client = new FailingInitializeClient();
    const probe = createProductionLiveProbe(dependencies(client));

    const report = await probe.runProbe(
      { status: "unavailable" },
      { resourceChallengeCompleted: true },
    );

    expect(report.gates[1]).toMatchObject({
      id: "P0-B",
      status: "failed",
      diagnosticCode: "HOST_CAPABILITY_UNAVAILABLE",
    });
    expect(JSON.stringify(report)).not.toMatch(/thr_initialize_secret|Private|initialize/u);
  });

  it("marks roots/list rejection as failed instead of capability absence", async () => {
    const client = new FakeLiveClient();
    const probe = createProductionLiveProbe({
      ...dependencies(client),
      getMcpRoots: async () => {
        throw new Error("roots timeout thr_secret C:\\Private\\roots");
      },
    });

    const report = await probe.runProbe(
      { status: "unavailable" },
      { resourceChallengeCompleted: true },
    );

    expect(report.gates[1]).toMatchObject({
      id: "P0-B",
      status: "failed",
      diagnosticCode: "HOST_CAPABILITY_UNAVAILABLE",
    });
    expect(client.projectCalls).toEqual([]);
    expect(JSON.stringify(report)).not.toMatch(/thr_secret|Private|roots timeout/u);
  });

  it("does not convert a candidate thread/read failure into project-only fallback", async () => {
    const client = new FailingReadClient();
    const probe = createProductionLiveProbe(dependencies(client));
    const binding = probe.captureHostContext({ "openai/threadId": "thr_live_secret" });

    const report = await probe.runProbe(binding, { resourceChallengeCompleted: true });

    expect(report.gates[1]).toMatchObject({ id: "P0-B", status: "failed" });
    expect(report.gates[2]?.status).toBe("not_run");
    expect(client.projectCalls).toEqual([]);
    expect(JSON.stringify(report)).not.toMatch(/thr_read_secret|Private/u);
  });

  it("keeps exact binding passed when the parent has no completed cutoff turn", async () => {
    const client = new FakeLiveClient();
    client.parent = { ...parentThread(), turns: [turn("turn_active_secret", "inProgress")] };
    const probe = createProductionLiveProbe(dependencies(client));
    const binding = probe.captureHostContext({ "openai/threadId": "thr_live_secret" });

    const report = await probe.runProbe(binding, { resourceChallengeCompleted: true });

    expect(report.gates[1]).toMatchObject({ id: "P0-B", status: "passed" });
    expect(report.gates[2]).toMatchObject({ id: "P0-C", status: "not_run" });
    expect(client.forkCalls).toEqual([]);
    expect(client.projectCalls).toEqual([]);
  });

  it.each([
    { name: "agreeing roots/list", roots: () => [{ uri: rootUri() }] },
    { name: "roots/list unavailable", roots: () => undefined },
  ])("keeps metadata opaque and verifies the exact cutoff fork with $name", async ({ roots }) => {
    const client = new FakeLiveClient();
    const probe = createProductionLiveProbe(dependencies(client, roots()));
    const binding = probe.captureHostContext({
      "openai/threadId": "thr_live_secret",
      "openai/turnId": "turn_active_secret",
      ignored: "D:\\Private\\must-not-escape",
    });

    expect(binding).toEqual({ status: "candidate", bindingToken: "opaque-live-1" });
    expect(JSON.stringify(binding)).not.toContain("thr_live_secret");

    const report = await probe.runProbe(binding, { resourceChallengeCompleted: true });

    expect(client.readCalls).toEqual(["thr_live_secret", "thr_live_secret"]);
    expect(client.forkCalls).toEqual([
      {
        threadId: "thr_live_secret",
        lastTurnId: "turn_completed_secret",
        emptyCwd: MODEL_SANDBOX_PATH,
        developerInstructions: SERVER_OWNED_MODEL_POLICY,
      },
    ]);
    expect(client.projectCalls).toEqual([]);
    expect(client.turnCalls).toBe(0);
    expect(client.closeCalls).toBe(1);
    expect(report.gates).toEqual([
      expect.objectContaining({
        id: "P0-A",
        status: "inconclusive",
        summary: "The resource challenge completed, but host UI provenance was not attested.",
        diagnosticCode: "UI_PROVENANCE_UNATTESTED",
      }),
      expect.objectContaining({ id: "P0-B", status: "passed" }),
      expect.objectContaining({ id: "P0-C", status: "passed" }),
      expect.objectContaining({
        id: "P0-D",
        status: "not_run",
        diagnosticCode: "CONTEXT_FIDELITY_UNVERIFIED",
      }),
      expect.objectContaining({
        id: "P0-E",
        status: "not_run",
        diagnosticCode: "FAILURE_MATRIX_INCOMPLETE",
      }),
    ]);
    expect(report.featureFlags).toEqual({
      task_and_project: false,
      project_only: false,
      reader_only: false,
    });
    expect(JSON.stringify(report)).not.toMatch(/thr_live_secret|turn_active_secret|Private|Project[\\/]Fixture/u);
  });

  it("creates only a clean project-only ephemeral fallback from an MCP root", async () => {
    const client = new FakeLiveClient();
    const probe = createProductionLiveProbe(dependencies(client));
    const binding = probe.captureHostContext({
      "openai/session": "anonymous-session-is-not-a-task",
    });

    expect(binding).toEqual({ status: "unavailable" });
    const report = await probe.runProbe(binding, { resourceChallengeCompleted: true });

    expect(client.readCalls).toEqual([]);
    expect(client.forkCalls).toEqual([]);
    expect(client.projectCalls).toEqual([MODEL_SANDBOX_PATH]);
    expect(client.turnCalls).toBe(0);
    expect(report.gates[1]).toMatchObject({
      id: "P0-B",
      status: "unsupported",
      diagnosticCode: "TASK_BINDING_UNAVAILABLE",
    });
    expect(report.gates[2]).toMatchObject({ id: "P0-C", status: "not_run" });
    expect(report.gates[3]).toMatchObject({ id: "P0-D", status: "not_run" });
    expect(report.featureFlags).toEqual({
      task_and_project: false,
      project_only: false,
      reader_only: false,
    });
  });

  it("fails closed when project-only mode has multiple MCP roots and no trusted document", async () => {
    const client = new FakeLiveClient();
    const probe = createProductionLiveProbe(dependencies(client, [
      { uri: rootUri(projectRoot) },
      { uri: rootUri(otherRoot) },
    ]));

    const report = await probe.runProbe(
      { status: "unavailable" },
      { resourceChallengeCompleted: true },
    );

    expect(client.readCalls).toEqual([]);
    expect(client.forkCalls).toEqual([]);
    expect(client.projectCalls).toEqual([]);
    expect(client.turnCalls).toBe(0);
    expect(report.gates[1]).toMatchObject({
      id: "P0-B",
      status: "unsupported",
      diagnosticCode: "TASK_BINDING_UNAVAILABLE",
    });
    expect(report.featureFlags.project_only).toBe(false);
  });

  it("fails closed when roots/list conflicts with the authoritative thread/read cwd", async () => {
    const client = new FakeLiveClient();
    client.parent = parentThread(otherRoot);
    const probe = createProductionLiveProbe(dependencies(client));
    const binding = probe.captureHostContext({ "openai/threadId": "thr_live_secret" });

    const report = await probe.runProbe(binding, { resourceChallengeCompleted: true });

    expect(client.forkCalls).toEqual([]);
    expect(client.projectCalls).toEqual([]);
    expect(client.turnCalls).toBe(0);
    expect(report.gates[1]).toMatchObject({
      id: "P0-B",
      status: "failed",
      diagnosticCode: "TASK_BINDING_UNAVAILABLE",
    });
    expect(JSON.stringify(report)).not.toContain(otherRoot);
  });

  it("rejects an exact root replaced at the same path during binding verification", async () => {
    const replaceableRoot = join(temporaryRoot, "replaceable-exact");
    const displacedRoot = join(temporaryRoot, "displaced-exact");
    await mkdir(replaceableRoot, { recursive: true });
    const client = new FakeLiveClient();
    client.parent = parentThread(replaceableRoot);
    const originalRead = client.readThread.bind(client);
    client.readThread = async (threadId: string) => {
      const observed = await originalRead(threadId);
      if (client.readCalls.length === 2) {
        await rename(replaceableRoot, displacedRoot);
        await mkdir(replaceableRoot);
      }
      return observed;
    };
    const probe = createProductionLiveProbe(dependencies(client, [
      { uri: rootUri(replaceableRoot) },
    ]));
    const binding = probe.captureHostContext({ "openai/threadId": "thr_live_secret" });

    const report = await probe.runProbe(binding, { resourceChallengeCompleted: true });

    expect(report.gates[1]?.status).toBe("failed");
    expect(report.gates[2]?.status).not.toBe("passed");
    expect(client.forkCalls).toEqual([]);
    expect(JSON.stringify(report)).not.toMatch(/replaceable-exact|displaced-exact/u);
  });

  it("rejects a project root replaced at the same path during session creation", async () => {
    const replaceableRoot = join(temporaryRoot, "replaceable-project");
    const displacedRoot = join(temporaryRoot, "displaced-project");
    await mkdir(replaceableRoot, { recursive: true });
    const client = new FakeLiveClient();
    client.startProjectEphemeralThread = async (input) => {
      client.projectCalls.push(input.emptyCwd);
      await rename(replaceableRoot, displacedRoot);
      await mkdir(replaceableRoot);
      return {
        id: "thr_project_secret",
        cwd: input.emptyCwd,
        ephemeral: true,
        forkedFromId: null,
        status: { type: "idle" },
        turns: [],
      };
    };
    const probe = createProductionLiveProbe(dependencies(client, [
      { uri: rootUri(replaceableRoot) },
    ]));

    const report = await probe.runProbe(
      { status: "unavailable" },
      { resourceChallengeCompleted: true },
    );

    expect(client.projectCalls).toEqual([MODEL_SANDBOX_PATH]);
    expect(report.gates[3]).toMatchObject({ id: "P0-D", status: "failed" });
    expect(JSON.stringify(report)).not.toMatch(/replaceable-project|displaced-project/u);
  });

  it("keeps the first project root identity authoritative across App Server startup", async () => {
    const replaceableRoot = join(temporaryRoot, "replaceable-project-startup");
    const displacedRoot = join(temporaryRoot, "displaced-project-startup");
    await mkdir(replaceableRoot, { recursive: true });
    const client = new FakeLiveClient();
    const base = dependencies(client, [{ uri: rootUri(replaceableRoot) }]);
    const probe = createProductionLiveProbe({
      ...base,
      resolveExecutable: async () => {
        await rename(replaceableRoot, displacedRoot);
        await mkdir(replaceableRoot);
        return await base.resolveExecutable();
      },
    });

    const report = await probe.runProbe(
      { status: "unavailable" },
      { resourceChallengeCompleted: true },
    );

    expect(client.projectCalls).toEqual([]);
    expect(report.gates[3]).toMatchObject({ id: "P0-D", status: "failed" });
    expect(JSON.stringify(report)).not.toMatch(/replaceable-project-startup|displaced-project-startup/u);
  });

  it("rejects an exact root replaced while the isolation check is running", async () => {
    const replaceableRoot = join(temporaryRoot, "replaceable-exact-final");
    const displacedRoot = join(temporaryRoot, "displaced-exact-final");
    await mkdir(replaceableRoot, { recursive: true });
    const client = new FakeLiveClient();
    client.parent = parentThread(replaceableRoot);
    const statusSpy = vi.spyOn(ContextBridge.prototype, "modelExecutionStatus").mockImplementation(async () => {
      await rename(replaceableRoot, displacedRoot);
      await mkdir(replaceableRoot);
      return {
        status: "reader_only",
        code: "MODEL_ISOLATION_UNPROVEN",
        missing: ["effectiveTools.hostAttestation"],
      };
    });
    try {
      const probe = createProductionLiveProbe(dependencies(client, [
        { uri: rootUri(replaceableRoot) },
      ]));
      const binding = probe.captureHostContext({ "openai/threadId": "thr_live_secret" });

      const report = await probe.runProbe(binding, { resourceChallengeCompleted: true });

      expect(report.gates[1]?.status).toBe("failed");
      expect(report.gates[2]?.status).not.toBe("passed");
      expect(JSON.stringify(report)).not.toMatch(/replaceable-exact-final|displaced-exact-final/u);
    } finally {
      statusSpy.mockRestore();
    }
  });

  it("rejects a project root replaced while the isolation check is running", async () => {
    const replaceableRoot = join(temporaryRoot, "replaceable-project-final");
    const displacedRoot = join(temporaryRoot, "displaced-project-final");
    await mkdir(replaceableRoot, { recursive: true });
    const client = new FakeLiveClient();
    const statusSpy = vi.spyOn(ContextBridge.prototype, "modelExecutionStatus").mockImplementation(async () => {
      await rename(replaceableRoot, displacedRoot);
      await mkdir(replaceableRoot);
      return {
        status: "reader_only",
        code: "MODEL_ISOLATION_UNPROVEN",
        missing: ["effectiveTools.hostAttestation"],
      };
    });
    try {
      const probe = createProductionLiveProbe(dependencies(client, [
        { uri: rootUri(replaceableRoot) },
      ]));

      const report = await probe.runProbe(
        { status: "unavailable" },
        { resourceChallengeCompleted: true },
      );

      expect(report.gates[3]).toMatchObject({ id: "P0-D", status: "failed" });
      expect(JSON.stringify(report)).not.toMatch(/replaceable-project-final|displaced-project-final/u);
    } finally {
      statusSpy.mockRestore();
    }
  });

  it("rejects an unknown or replayed binding token instead of exposing or reusing the candidate", async () => {
    const client = new FakeLiveClient();
    const probe = createProductionLiveProbe(dependencies(client));
    const captured = probe.captureHostContext({ "openai/threadId": "thr_live_secret" });

    const observation = { resourceChallengeCompleted: true } as const;
    const first = await probe.runProbe(captured, observation);
    const replay = await probe.runProbe(captured, observation);
    const unknown = await probe.runProbe(
      { status: "candidate", bindingToken: "opaque-unknown" },
      observation,
    );

    expect(first.gates[1]?.status).toBe("passed");
    expect(replay.gates[1]).toMatchObject({ id: "P0-B", status: "failed" });
    expect(unknown.gates[1]).toMatchObject({ id: "P0-B", status: "failed" });
    expect(client.forkCalls).toHaveLength(1);
  });

  it("does not invent task or project capability when the schema-matched App Server is unavailable", async () => {
    const client = new FakeLiveClient();
    const probe = createProductionLiveProbe({
      ...dependencies(client),
      resolveExecutable: async () => ({
        status: "unavailable",
        code: "CODEX_DESKTOP_VERSION_MISMATCH",
        retryable: false,
      }),
    });

    const report = await probe.runProbe(
      { status: "unavailable" },
      { resourceChallengeCompleted: true },
    );

    expect(client.projectCalls).toEqual([]);
    expect(report.gates[1]).toMatchObject({
      id: "P0-B",
      status: "unsupported",
      diagnosticCode: "HOST_CAPABILITY_UNAVAILABLE",
    });
    expect(report.featureFlags).toEqual({
      task_and_project: false,
      project_only: false,
      reader_only: false,
    });
    expect(JSON.stringify(report)).not.toContain("CODEX_DESKTOP_VERSION_MISMATCH");
  });
});
