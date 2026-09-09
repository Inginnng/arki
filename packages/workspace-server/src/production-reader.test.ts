import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type { ReaderSession } from "@aimd/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createProductionReaderService,
  type ProductionBridgeInput,
  type ProductionBridgeRuntime,
} from "./production-reader.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe("production reader composition", () => {
  it("opens only negotiated MCP roots, exposes guarded Markdown, and revokes session access with the root", async () => {
    const projectRoot = await temporaryDirectory("aimd-production-project-");
    const dataRoot = await temporaryDirectory("aimd-production-data-");
    const otherRoot = await temporaryDirectory("aimd-production-other-");
    await writeFile(join(projectRoot, "README.md"), "# Architecture\n\nCurrent project facts.\n", "utf8");
    await mkdir(join(projectRoot, "docs"), { recursive: true });
    await writeFile(join(projectRoot, "docs", "guide.markdown"), "# Guide\n", "utf8");
    await mkdir(join(projectRoot, "secret"), { recursive: true });
    await writeFile(join(projectRoot, "secret", "hidden.md"), "# Hidden\n", "utf8");
    await mkdir(join(projectRoot, "node_modules", "fixture"), { recursive: true });
    await writeFile(join(projectRoot, "node_modules", "fixture", "ignored.md"), "# Ignored\n", "utf8");

    const closeBridge = vi.fn(async () => undefined);
    const connectBridge = vi.fn(async (input): Promise<ProductionBridgeRuntime> => ({
      bridge: {
        verifyBinding: vi.fn(async () => ({
          status: "unavailable" as const,
          code: "TASK_CONTEXT_UNAVAILABLE" as const,
        })),
        createSession: vi.fn(async (_binding, _root, documentPath): Promise<ReaderSession> => ({
          id: "session-production-root",
          bindingStatus: "unavailable",
          contextMode: "project_only",
          rootId: input.workspaceSnapshot.publicSnapshot.rootId,
          workspaceLabel: input.workspaceLabel,
          documentPath,
          degradationReason: "Task context unavailable; project evidence only",
        })),
        async *ask() {
          yield { type: "failed" as const, code: "MODEL_ISOLATION_UNPROVEN" as const };
        },
        auditEvidence: vi.fn(async () => ({
          status: "failed" as const,
          code: "MODEL_ISOLATION_UNPROVEN" as const,
        })),
        issueAcceptedSynthesisAnnotation: vi.fn(() => {
          throw new Error("MODEL_ISOLATION_UNPROVEN");
        }),
        synthesize: vi.fn(async () => ({
          status: "failed" as const,
          code: "MODEL_ISOLATION_UNPROVEN" as const,
        })),
      },
      close: closeBridge,
    }));
    const service = createProductionReaderService({
      environment: { AIMD_DENY_GLOBS: '["secret/**"]' },
      userDataBaseDir: dataRoot,
      connectBridge,
      writer: {
        capability: vi.fn(async () => ({ status: "unavailable" as const, code: "SAFE_WRITE_UNAVAILABLE" as const })),
        createExplainedSibling: vi.fn(async () => {
          throw new Error("SAFE_WRITE_UNAVAILABLE");
        }),
      },
    });
    const authorizedRoots = [{ uri: pathToFileURL(projectRoot).href }];

    const roots = await service.listRoots(authorizedRoots) as Array<{ rootId: string; workspaceLabel: string }>;
    expect(roots).toHaveLength(1);
    expect(roots[0]?.workspaceLabel).toBe(projectRoot.split(/[\\/]/u).at(-1));
    expect(JSON.stringify(roots)).not.toContain(projectRoot);
    expect(connectBridge).not.toHaveBeenCalled();

    const documents = await service.listDocuments(roots[0]!.rootId) as Array<{ path: string; title: string }>;
    expect(connectBridge).toHaveBeenCalledTimes(1);
    expect(documents).toEqual([
      expect.objectContaining({ path: "README.md", title: "Architecture" }),
      expect.objectContaining({ path: "docs/guide.markdown", title: "Guide" }),
    ]);
    expect(documents).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ path: expect.stringMatching(/hidden|ignored/u) }),
    ]));

    const opened = await service.openDocument(roots[0]!.rootId, "README.md") as { markdown: string };
    expect(opened.markdown).toContain("Current project facts.");
    const binding = service.captureSessionBinding({ "openai/threadId": "thread-production" });
    const session = await service.createSessionFromBinding(roots[0]!.rootId, "README.md", binding) as ReaderSession;
    await expect(service.authorizeAccess({ kind: "session", id: session.id }, authorizedRoots))
      .resolves.toBeUndefined();
    await expect(service.authorizeAccess(
      { kind: "session", id: session.id },
      [{ uri: pathToFileURL(otherRoot).href }],
    )).rejects.toMatchObject({ code: "ROOT_AUTHORIZATION_REVOKED" });

    const firstClose = service.close();
    expect(service.close()).toBe(firstClose);
    await firstClose;
    expect(closeBridge).toHaveBeenCalledTimes(1);
  });

  it("returns no roots when roots/list is unavailable instead of using process.cwd", async () => {
    const connectBridge = vi.fn();
    const service = createProductionReaderService({
      connectBridge,
      writer: {
        capability: vi.fn(async () => ({ status: "unavailable" as const, code: "SAFE_WRITE_UNAVAILABLE" as const })),
        createExplainedSibling: vi.fn(async () => {
          throw new Error("SAFE_WRITE_UNAVAILABLE");
        }),
      },
    });

    await expect(service.listRoots()).resolves.toEqual([]);
    expect(connectBridge).not.toHaveBeenCalled();
    await service.close();
  });

  it("reopens persisted sessions for history but requires a fresh task-context binding after restart", async () => {
    const projectRoot = await temporaryDirectory("aimd-production-recovery-project-");
    const dataRoot = await temporaryDirectory("aimd-production-recovery-data-");
    await writeFile(join(projectRoot, "README.md"), "# Recovery\n", "utf8");
    const authorizedRoots = [{ uri: pathToFileURL(projectRoot).href }];
    let sessionSequence = 0;
    const connectBridge = async (input: ProductionBridgeInput): Promise<ProductionBridgeRuntime> => ({
      bridge: {
        verifyBinding: async () => ({ status: "unavailable", code: "TASK_CONTEXT_UNAVAILABLE" }),
        createSession: async (_binding, _root, documentPath) => ({
          id: `session-recovery-${++sessionSequence}`,
          bindingStatus: "unavailable",
          contextMode: "project_only",
          rootId: input.workspaceSnapshot.publicSnapshot.rootId,
          workspaceLabel: input.workspaceLabel,
          documentPath,
          degradationReason: "Task context unavailable; project evidence only",
        }),
        async *ask() { yield { type: "failed" as const, code: "MODEL_ISOLATION_UNPROVEN" as const }; },
        auditEvidence: async () => ({ status: "failed", code: "MODEL_ISOLATION_UNPROVEN" }),
        issueAcceptedSynthesisAnnotation: () => { throw new Error("MODEL_ISOLATION_UNPROVEN"); },
        synthesize: async () => ({ status: "failed", code: "MODEL_ISOLATION_UNPROVEN" }),
      },
      close: async () => undefined,
    });
    const options = {
      environment: {},
      userDataBaseDir: dataRoot,
      connectBridge,
      writer: {
        capability: async () => ({ status: "unavailable" as const, code: "SAFE_WRITE_UNAVAILABLE" as const }),
        createExplainedSibling: async () => { throw new Error("SAFE_WRITE_UNAVAILABLE"); },
      },
    };

    const first = createProductionReaderService(options);
    const firstRoots = await first.listRoots(authorizedRoots) as Array<{ rootId: string }>;
    const session = await first.createSessionFromBinding(
      firstRoots[0]!.rootId,
      "README.md",
      first.captureSessionBinding(undefined),
    ) as ReaderSession;
    await first.close();

    const reopened = createProductionReaderService(options);
    const reopenedRoots = await reopened.listRoots(authorizedRoots) as Array<{ rootId: string }>;
    expect(reopenedRoots[0]!.rootId).not.toBe(firstRoots[0]!.rootId);
    await expect(reopened.listDocuments(firstRoots[0]!.rootId))
      .rejects.toMatchObject({ code: "ROOT_NOT_FOUND" });
    await reopened.listDocuments(reopenedRoots[0]!.rootId);
    await expect(reopened.authorizeAccess({ kind: "session", id: session.id }, authorizedRoots))
      .resolves.toBeUndefined();
    await expect(reopened.startQuestion(session.id, {
      question: "Does the recovered session still have its side-thread context?",
      startOffset: 0,
      endOffset: 10,
    })).rejects.toMatchObject({ code: "SERVER_RESTARTED" });
    await reopened.close();
  });

  it("narrows a parent MCP root to exact thread cwd only when the selected document is inside it", async () => {
    const parentRoot = await temporaryDirectory("aimd-production-parent-root-");
    const dataRoot = await temporaryDirectory("aimd-production-narrow-data-");
    const taskRoot = join(parentRoot, "packages", "task-app");
    await mkdir(taskRoot, { recursive: true });
    await writeFile(join(taskRoot, "README.md"), "# Task app\n", "utf8");
    await writeFile(join(parentRoot, "outside.md"), "# Parent document\n", "utf8");
    const connectBridge = vi.fn(async (input: ProductionBridgeInput): Promise<ProductionBridgeRuntime> => ({
      resolveTaskWorkspace: async () => ({ status: "resolved", workspaceRoot: taskRoot }),
      bridge: {
        verifyBinding: async () => input.canonicalRoot === taskRoot
          ? { status: "verified", bindingId: "binding-task-root", cutoffLabel: "Through the latest completed parent turn" }
          : { status: "mismatch", code: "TASK_WORKSPACE_MISMATCH" },
        createSession: async (binding, _root, documentPath) => ({
          id: `session-${input.workspaceSnapshot.publicSnapshot.rootId}`,
          bindingStatus: binding.status,
          contextMode: binding.status === "verified" ? "task_and_project" : "project_only",
          rootId: input.workspaceSnapshot.publicSnapshot.rootId,
          workspaceLabel: input.workspaceLabel,
          documentPath,
          ...(binding.status === "verified"
            ? { cutoffLabel: binding.cutoffLabel }
            : { degradationReason: "Task workspace does not own this document" }),
        }),
        async *ask() { yield { type: "failed" as const, code: "MODEL_ISOLATION_UNPROVEN" as const }; },
        auditEvidence: async () => ({ status: "failed", code: "MODEL_ISOLATION_UNPROVEN" }),
        issueAcceptedSynthesisAnnotation: () => { throw new Error("MODEL_ISOLATION_UNPROVEN"); },
        synthesize: async () => ({ status: "failed", code: "MODEL_ISOLATION_UNPROVEN" }),
      },
      close: async () => undefined,
    }));
    const service = createProductionReaderService({
      environment: {},
      userDataBaseDir: dataRoot,
      connectBridge,
      writer: {
        capability: async () => ({ status: "unavailable", code: "SAFE_WRITE_UNAVAILABLE" }),
        createExplainedSibling: async () => { throw new Error("SAFE_WRITE_UNAVAILABLE"); },
      },
    });
    const authorizedRoots = [{ uri: pathToFileURL(parentRoot).href }];
    const [listedRoot] = await service.listRoots(authorizedRoots) as Array<{ rootId: string }>;
    const binding = service.captureSessionBinding({ "openai/threadId": "thread-task-root" });

    const narrowed = await service.createSessionFromBinding(
      listedRoot!.rootId,
      "packages/task-app/README.md",
      binding,
    ) as ReaderSession;
    expect(narrowed).toMatchObject({
      bindingStatus: "verified",
      contextMode: "task_and_project",
      documentPath: "README.md",
    });

    const outside = await service.createSessionFromBinding(
      listedRoot!.rootId,
      "outside.md",
      binding,
    ) as ReaderSession;
    expect(outside).toMatchObject({
      bindingStatus: "mismatch",
      contextMode: "project_only",
      documentPath: "outside.md",
    });
    expect(await service.listRoots(authorizedRoots)).toHaveLength(1);
    await service.close();
  });

  it("releases revoked roots and keeps lazy root creation globally bounded", async () => {
    const firstRoot = await temporaryDirectory("aimd-production-bounded-first-");
    const secondRoot = await temporaryDirectory("aimd-production-bounded-second-");
    const dataRoot = await temporaryDirectory("aimd-production-bounded-data-");
    await writeFile(join(firstRoot, "README.md"), "# First\n", "utf8");
    await writeFile(join(secondRoot, "README.md"), "# Second\n", "utf8");
    const closes: Array<ReturnType<typeof vi.fn>> = [];
    const connectBridge = vi.fn(async (input: ProductionBridgeInput): Promise<ProductionBridgeRuntime> => {
      const close = vi.fn(async () => undefined);
      closes.push(close);
      return { ...unavailableProductionBridge(input), close };
    });
    const service = createProductionReaderService({
      userDataBaseDir: dataRoot,
      connectBridge,
      limits: { maxRuntimes: 1 },
      writer: unavailableWriter(),
    });

    const both = await service.listRoots([
      { uri: pathToFileURL(firstRoot).href },
      { uri: pathToFileURL(secondRoot).href },
    ]) as Array<{ rootId: string }>;
    expect(both).toHaveLength(1);
    expect(connectBridge).not.toHaveBeenCalled();
    await expect(service.authorizeAccess(
      { kind: "session", id: "unknown-session" },
      [
        { uri: pathToFileURL(firstRoot).href },
        { uri: pathToFileURL(secondRoot).href },
      ],
    )).rejects.toMatchObject({ code: "SESSION_NOT_FOUND" });
    expect(connectBridge).not.toHaveBeenCalled();
    await service.listDocuments(both[0]!.rootId);
    expect(connectBridge).toHaveBeenCalledTimes(1);

    const secondOnly = await service.listRoots([{ uri: pathToFileURL(secondRoot).href }]) as Array<{ rootId: string }>;
    expect(secondOnly).toHaveLength(1);
    expect(connectBridge).toHaveBeenCalledTimes(1);
    expect(closes[0]).toHaveBeenCalledTimes(1);
    await expect(service.listDocuments(both[0]!.rootId)).rejects.toMatchObject({ code: "ROOT_NOT_FOUND" });
    await service.listDocuments(secondOnly[0]!.rootId);
    expect(connectBridge).toHaveBeenCalledTimes(2);

    await service.close();
    expect(closes[1]).toHaveBeenCalledTimes(1);
  });

  it("waits for a runtime still resolving during close and closes its bridge exactly once", async () => {
    const projectRoot = await temporaryDirectory("aimd-production-close-pending-");
    const dataRoot = await temporaryDirectory("aimd-production-close-pending-data-");
    await writeFile(join(projectRoot, "README.md"), "# Pending\n", "utf8");
    let releaseBridge!: () => void;
    let markBridgeStarted!: () => void;
    const bridgeStarted = new Promise<void>((resolve) => { markBridgeStarted = resolve; });
    const bridgeReleased = new Promise<void>((resolve) => { releaseBridge = resolve; });
    const closeBridge = vi.fn(async () => undefined);
    const service = createProductionReaderService({
      userDataBaseDir: dataRoot,
      connectBridge: async (input) => {
        markBridgeStarted();
        await bridgeReleased;
        return { ...unavailableProductionBridge(input), close: closeBridge };
      },
      writer: unavailableWriter(),
    });

    const [root] = await service.listRoots([{ uri: pathToFileURL(projectRoot).href }]) as Array<{ rootId: string }>;
    expect(closeBridge).not.toHaveBeenCalled();
    const accessing = service.listDocuments(root!.rootId);
    await bridgeStarted;
    const closing = service.close();
    let closed = false;
    void closing.then(() => { closed = true; });
    await Promise.resolve();
    expect(closed).toBe(false);
    releaseBridge();

    await expect(accessing).rejects.toMatchObject({ code: "SERVICE_CLOSED" });
    await closing;
    expect(closeBridge).toHaveBeenCalledTimes(1);
  });

  it("rejects a second active run when the production run route budget is exhausted", async () => {
    const projectRoot = await temporaryDirectory("aimd-production-run-budget-");
    const dataRoot = await temporaryDirectory("aimd-production-run-budget-data-");
    await writeFile(join(projectRoot, "README.md"), "# Budget\n\nSelected text.\n", "utf8");
    const service = createProductionReaderService({
      userDataBaseDir: dataRoot,
      limits: { maxRunRoutes: 1 },
      connectBridge: async (input) => ({
        bridge: {
          ...unavailableProductionBridge(input).bridge,
          async *ask(_sessionId, _question, signal) {
            await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
          },
        },
        close: async () => undefined,
      }),
      writer: unavailableWriter(),
    });
    const roots = [{ uri: pathToFileURL(projectRoot).href }];
    const [root] = await service.listRoots(roots) as Array<{ rootId: string }>;
    const session = await service.createSessionFromBinding(
      root!.rootId,
      "README.md",
      service.captureSessionBinding(undefined),
    ) as ReaderSession;
    const first = await service.startQuestion(session.id, {
      question: "What is selected?",
      startOffset: 10,
      endOffset: 23,
    }) as { runId: string };

    await expect(service.startQuestion(session.id, {
      question: "And again?",
      startOffset: 10,
      endOffset: 23,
    })).rejects.toMatchObject({ code: "RUN_CAPACITY_EXCEEDED" });

    await service.cancelQuestion(first.runId);
    await service.close();
  });

  it("waits for an outer question start reservation before production close resolves", async () => {
    const projectRoot = await temporaryDirectory("aimd-production-close-start-");
    const dataRoot = await temporaryDirectory("aimd-production-close-start-data-");
    await writeFile(join(projectRoot, "README.md"), "# Budget\n\nSelected text.\n", "utf8");
    let markReserved!: () => void;
    let releaseReservation!: () => void;
    const reserved = new Promise<void>((resolve) => { markReserved = resolve; });
    const reservationReleased = new Promise<void>((resolve) => { releaseReservation = resolve; });
    const service = createProductionReaderService({
      userDataBaseDir: dataRoot,
      connectBridge: async (input) => ({
        ...unavailableProductionBridge(input),
        close: async () => undefined,
      }),
      afterRunRouteReserved: async () => {
        markReserved();
        await reservationReleased;
      },
      writer: unavailableWriter(),
    });
    const roots = [{ uri: pathToFileURL(projectRoot).href }];
    const [root] = await service.listRoots(roots) as Array<{ rootId: string }>;
    const session = await service.createSessionFromBinding(
      root!.rootId,
      "README.md",
      service.captureSessionBinding(undefined),
    ) as ReaderSession;
    const starting = service.startQuestion(session.id, {
      question: "Start while shutdown begins",
      startOffset: 10,
      endOffset: 23,
    });
    await reserved;

    const closing = service.close();
    let closed = false;
    void closing.then(() => { closed = true; });
    await Promise.resolve();
    expect(closed).toBe(false);
    releaseReservation();

    const started = await starting as { runId: string };
    await closing;
    await expect(service.pollQuestion(started.runId))
      .rejects.toMatchObject({ code: "RUN_NOT_FOUND" });
    await expect(service.startQuestion(session.id, {
      question: "No starts after close",
      startOffset: 10,
      endOffset: 23,
    })).rejects.toMatchObject({ code: "SERVICE_CLOSED" });
  });

  it("does not let concurrent recovered history consume an in-flight run reservation", async () => {
    const firstRoot = await temporaryDirectory("aimd-production-reserved-first-");
    const secondRoot = await temporaryDirectory("aimd-production-reserved-second-");
    const dataRoot = await temporaryDirectory("aimd-production-reserved-data-");
    const markdown = "# Budget\n\nSelected text.\n";
    await writeFile(join(firstRoot, "README.md"), markdown, "utf8");
    await writeFile(join(secondRoot, "README.md"), markdown, "utf8");
    const roots = [
      { uri: pathToFileURL(firstRoot).href },
      { uri: pathToFileURL(secondRoot).href },
    ];
    const activeBridge = async (input: ProductionBridgeInput): Promise<ProductionBridgeRuntime> => ({
      bridge: {
        ...unavailableProductionBridge(input).bridge,
        async *ask(_sessionId, _question, signal) {
          await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
          yield { type: "cancelled" as const };
        },
      },
      close: async () => undefined,
    });

    // Leave a genuinely queued draft in the second root, as an abrupt server
    // stop would, so the main service must consider it during first activation.
    const seed = createProductionReaderService({
      userDataBaseDir: dataRoot,
      connectBridge: activeBridge,
      writer: unavailableWriter(),
    });
    const [seedRoot] = await seed.listRoots([roots[1]!]) as Array<{ rootId: string }>;
    const seedSession = await seed.createSessionFromBinding(
      seedRoot!.rootId,
      "README.md",
      seed.captureSessionBinding(undefined),
    ) as ReaderSession;
    const recovered = await seed.startQuestion(seedSession.id, {
      question: "Remain queued for recovery",
      startOffset: 10,
      endOffset: 23,
    }) as { runId: string };

    let blockReservation = false;
    let markReserved!: () => void;
    let releaseReservation!: () => void;
    const reserved = new Promise<void>((resolve) => { markReserved = resolve; });
    const reservationReleased = new Promise<void>((resolve) => { releaseReservation = resolve; });
    const service = createProductionReaderService({
      userDataBaseDir: dataRoot,
      limits: { maxRunRoutes: 2 },
      connectBridge: activeBridge,
      afterRunRouteReserved: async () => {
        if (!blockReservation) return;
        markReserved();
        await reservationReleased;
      },
      writer: unavailableWriter(),
    });
    const listed = await service.listRoots(roots) as Array<{ rootId: string }>;
    const session = await service.createSessionFromBinding(
      listed[0]!.rootId,
      "README.md",
      service.captureSessionBinding(undefined),
    ) as ReaderSession;
    const first = await service.startQuestion(session.id, {
      question: "First active run",
      startOffset: 10,
      endOffset: 23,
    }) as { runId: string };

    blockReservation = true;
    const secondStarting = service.startQuestion(session.id, {
      question: "Second reserved run",
      startOffset: 10,
      endOffset: 23,
    }) as Promise<{ runId: string }>;
    await reserved;
    await service.listDocuments(listed[1]!.rootId);
    await expect(service.pollQuestion(recovered.runId))
      .rejects.toMatchObject({ code: "RUN_NOT_FOUND" });

    releaseReservation();
    const second = await secondStarting;
    await expect(service.startQuestion(session.id, {
      question: "Must not bypass two active reservations",
      startOffset: 10,
      endOffset: 23,
    })).rejects.toMatchObject({ code: "RUN_CAPACITY_EXCEEDED" });

    await service.cancelQuestion(first.runId);
    await service.cancelQuestion(second.runId);
    await service.close();
    await seed.close();
  });

  it("reclaims an unpolled terminal run route instead of exhausting capacity forever", async () => {
    const projectRoot = await temporaryDirectory("aimd-production-terminal-run-budget-");
    const dataRoot = await temporaryDirectory("aimd-production-terminal-run-budget-data-");
    await writeFile(join(projectRoot, "README.md"), "# Budget\n\nSelected text.\n", "utf8");
    let markGeneratorFinished!: () => void;
    const generatorFinished = new Promise<void>((resolve) => { markGeneratorFinished = resolve; });
    let askCount = 0;
    const service = createProductionReaderService({
      userDataBaseDir: dataRoot,
      limits: { maxRunRoutes: 1 },
      connectBridge: async (input) => ({
        bridge: {
          ...unavailableProductionBridge(input).bridge,
          async *ask(_sessionId, _question, signal) {
            if (askCount++ === 0) {
              try {
                yield { type: "failed" as const, code: "MODEL_ISOLATION_UNPROVEN" as const };
              } finally {
                markGeneratorFinished();
              }
              return;
            }
            await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
            yield { type: "cancelled" as const };
          },
        },
        close: async () => undefined,
      }),
      writer: unavailableWriter(),
    });
    const roots = [{ uri: pathToFileURL(projectRoot).href }];
    const [root] = await service.listRoots(roots) as Array<{ rootId: string }>;
    const session = await service.createSessionFromBinding(
      root!.rootId,
      "README.md",
      service.captureSessionBinding(undefined),
    ) as ReaderSession;
    const first = await service.startQuestion(session.id, {
      question: "What is selected?",
      startOffset: 10,
      endOffset: 23,
    }) as { runId: string };
    await generatorFinished;
    let second: { runId: string } | undefined;
    for (let attempt = 0; attempt < 50 && second === undefined; attempt += 1) {
      try {
        second = await service.startQuestion(session.id, {
          question: "Can this slot be reused?",
          startOffset: 10,
          endOffset: 23,
        }) as { runId: string };
      } catch (error) {
        if (!(error instanceof Error) || error.message !== "RUN_CAPACITY_EXCEEDED") throw error;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }
    expect(second).toBeDefined();
    expect(second!.runId).not.toBe(first.runId);
    await expect(service.pollQuestion(first.runId))
      .rejects.toMatchObject({ code: "RUN_NOT_FOUND" });
    await expect(service.startQuestion(session.id, {
      question: "Must not bypass the active route budget",
      startOffset: 10,
      endOffset: 23,
    })).rejects.toMatchObject({ code: "RUN_CAPACITY_EXCEEDED" });

    await service.cancelQuestion(second!.runId);
    await service.close();
  });
});

function unavailableProductionBridge(input: ProductionBridgeInput): Pick<ProductionBridgeRuntime, "bridge"> {
  return {
    bridge: {
      verifyBinding: async () => ({ status: "unavailable", code: "TASK_CONTEXT_UNAVAILABLE" }),
      createSession: async (_binding, _root, documentPath) => ({
        id: `session-${input.workspaceSnapshot.publicSnapshot.rootId}`,
        bindingStatus: "unavailable",
        contextMode: "project_only",
        rootId: input.workspaceSnapshot.publicSnapshot.rootId,
        workspaceLabel: input.workspaceLabel,
        documentPath,
        degradationReason: "Task context unavailable",
      }),
      async *ask() { yield { type: "failed" as const, code: "MODEL_ISOLATION_UNPROVEN" as const }; },
      auditEvidence: async () => ({ status: "failed", code: "MODEL_ISOLATION_UNPROVEN" }),
      issueAcceptedSynthesisAnnotation: () => { throw new Error("MODEL_ISOLATION_UNPROVEN"); },
      synthesize: async () => ({ status: "failed", code: "MODEL_ISOLATION_UNPROVEN" }),
    },
  };
}

function unavailableWriter() {
  return {
    capability: async () => ({ status: "unavailable" as const, code: "SAFE_WRITE_UNAVAILABLE" as const }),
    createExplainedSibling: async () => { throw new Error("SAFE_WRITE_UNAVAILABLE"); },
  };
}
