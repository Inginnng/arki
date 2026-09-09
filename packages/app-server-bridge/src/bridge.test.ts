import type { EvidenceAnswer, ModelAnswerCandidate } from "@aimd/contracts";
import {
  createWorkspaceSnapshot,
  issueEvidencePacket,
  sha256Text,
  validateEvidence,
  type EvidencePacket,
  type EvidenceSupportAuditResult,
  type WorkspaceSnapshotRecapturePlan,
} from "@aimd/reader-core";
import { describe, expect, it } from "vitest";

import type { UnverifiedBinding } from "./metadata.js";
import {
  ContextBridge as BaseContextBridge,
  ContextBridgeError,
  type AnchoredQuestion,
  type BridgeAppServerClient,
  type BridgeQuestionEvent,
  type TaskBindingResult,
} from "./bridge.js";
import type {
  AppServerEvent,
  AppServerThread,
} from "./client.js";
import {
  type ModelIsolationResult,
} from "./isolation.js";
import { issueModelIsolationAuthorityForTesting } from "./isolation.testing.js";
import { SERVER_OWNED_MODEL_POLICY } from "./policy.js";

const EMPTY_CWD = "C:\\Temp\\aimd-empty";
const DOCUMENT_TEXT = "# Architecture\n\nThe gateway routes requests.\n";
const DOCUMENT_HASH = sha256Text(DOCUMENT_TEXT);
const GATEWAY_TEXT = "export const gateway = true;\n";
const WORKSPACE_SNAPSHOT = createWorkspaceSnapshot({
  projectRoot: "D:/Project/Fixture",
  rootId: "root-fixture",
  branch: "main",
  head: "1".repeat(40),
  createdAt: "2026-09-02T00:00:00.000Z",
  gitState: {
    kind: "dirty",
    status: " M src/gateway.ts",
    contentDigest: sha256Text("bridge fixture dirty state"),
  },
  relevantFileHashes: [{ path: "src/gateway.ts", hash: sha256Text(GATEWAY_TEXT) }],
});
const SNAPSHOT_DIGEST = WORKSPACE_SNAPSHOT.snapshotDigest;

class ContextBridge extends BaseContextBridge {
  constructor(
    client: BridgeAppServerClient,
    options: Omit<ConstructorParameters<typeof BaseContextBridge>[1], "workspaceSnapshot">,
  ) {
    super(client, { ...options, workspaceSnapshot: WORKSPACE_SNAPSHOT });
  }
}

function issuedPacket(): EvidencePacket {
  return issueEvidencePacket(
    {
      runId: "run-1",
      generation: "generation-1",
      snapshotDigest: SNAPSHOT_DIGEST,
      sources: [{
        kind: "code_excerpt",
        path: "src/gateway.ts",
        excerpt: GATEWAY_TEXT.trimEnd(),
        fileHash: sha256Text(GATEWAY_TEXT),
        sourceLocationKey: "fixture-gateway",
        startLine: 1,
        endLine: 1,
      }],
    },
    {
      idFactory: (scope) => scope === "packet" ? "packet-1" : "evidence-1",
    },
  );
}

function anchoredQuestion(question: string, packet = issuedPacket()): AnchoredQuestion {
  return {
    question,
    contextMode: "task_and_project",
    sourceAnchor: {
      documentPath: "docs/design.md",
      documentHash: DOCUMENT_HASH,
      headingPath: ["Architecture"],
      selectedText: "gateway",
      prefix: "The ",
      suffix: " routes requests.",
      startOffset: 20,
      endOffset: 27,
    },
    runId: "run-1",
    generation: "generation-1",
    snapshotDigest: SNAPSHOT_DIGEST,
    workspaceSnapshot: WORKSPACE_SNAPSHOT,
    evidencePackets: [packet],
    expansionRequestsUsed: 0,
  };
}

function auditableCandidate(): ModelAnswerCandidate {
  return {
    conclusionClaimId: "claim-1",
    claims: [{
      id: "claim-1",
      statement: "The gateway is exported.",
      category: "code_fact",
      evidenceIds: ["evidence-1"],
    }],
    unknowns: [],
  };
}

async function citationValidatedAnswer(
  candidate: ModelAnswerCandidate = auditableCandidate(),
): Promise<EvidenceAnswer> {
  return await validateEvidence({
    candidate,
    packet: issuedPacket(),
    expectedRunId: "run-1",
    expectedGeneration: "generation-1",
    currentSnapshotDigest: SNAPSHOT_DIGEST,
    contextMode: "project_only",
    documentPath: "docs/design.md",
    readEvidence: async () => ({
      excerpt: GATEWAY_TEXT.trimEnd(),
      fileHash: sha256Text(GATEWAY_TEXT),
    }),
  });
}

function auditReview(answer: EvidenceAnswer) {
  return {
    id: "audit-1",
    reviewer: "independent_model" as const,
    modelAssisted: true as const,
    runId: answer.runId,
    generation: answer.generation,
    candidateDigest: answer.candidateDigest,
    snapshotDigest: answer.snapshotDigest,
    records: [{
      id: "audit-record-1",
      claimId: "claim-1",
      evidenceIds: ["evidence-1"],
      verdict: "directly_supported" as const,
      rationale: "The exact excerpt exports the gateway.",
    }],
  };
}

async function issueReviewedAnnotation(
  bridge: ContextBridge,
  client: FakeBridgeClient,
  sessionId: string,
): Promise<{
  annotation: ReturnType<ContextBridge["issueAcceptedSynthesisAnnotation"]>;
  auditResult: EvidenceSupportAuditResult;
  answer: EvidenceAnswer;
  candidate: ModelAnswerCandidate;
  anchor: AnchoredQuestion["sourceAnchor"];
}> {
  const { answer, candidate, anchor } = await askIssuedAnswer(
    bridge,
    client,
    sessionId,
  );
  const review = auditReview(answer);
  client.nextEvents.push([
    { type: "started", turnId: "audit_turn_secret" },
    { type: "text_delta", text: JSON.stringify(review) },
    {
      type: "completed",
      turn: {
        id: "audit_turn_secret",
        status: "completed",
        items: [{ type: "agentMessage", id: "audit_item_secret" }],
        startedAt: 1,
        completedAt: 2,
      },
    },
  ]);
  const audited = await bridge.auditEvidence({
    sessionId,
    candidate,
    answer,
    workspaceSnapshot: WORKSPACE_SNAPSHOT,
  });
  if (audited.status !== "completed") throw new Error("audit fixture failed");
  return {
    auditResult: audited.output,
    annotation: bridge.issueAcceptedSynthesisAnnotation(sessionId, {
      annotationId: "annotation-1",
      disposition: "inline",
      answer,
      auditResult: audited.output,
    }),
    answer,
    candidate,
    anchor,
  };
}

async function askIssuedAnswer(
  bridge: ContextBridge,
  client: FakeBridgeClient,
  sessionId: string,
  question: AnchoredQuestion = anchoredQuestion("auditable answer"),
): Promise<{
  answer: EvidenceAnswer;
  candidate: ModelAnswerCandidate;
  anchor: AnchoredQuestion["sourceAnchor"];
}> {
  const turnId = `auditable_turn_${client.turnCalls.length + 1}`;
  client.nextEvents.push([
    { type: "started", turnId },
    { type: "text_delta", text: JSON.stringify({ kind: "answer", answer: auditableCandidate() }) },
    {
      type: "completed",
      turn: { id: turnId, status: "completed", items: [], startedAt: 1, completedAt: 2 },
    },
  ]);
  const events = await collect(bridge.ask(sessionId, question));
  const terminal = events.at(-1);
  if (terminal?.type !== "completed" || terminal.output.kind !== "answer") {
    throw new Error("ask fixture failed");
  }
  return {
    candidate: terminal.output.answer,
    answer: await citationValidatedAnswer(terminal.output.answer),
    anchor: question.sourceAnchor,
  };
}

function appThread(overrides: Partial<AppServerThread> = {}): AppServerThread {
  return {
    id: "parent_secret",
    cwd: "D:\\Project\\Fixture",
    ephemeral: false,
    forkedFromId: null,
    status: { type: "active" },
    turns: [
      {
        id: "turn_done_1",
        status: "completed",
        items: [
          {
            type: "userMessage",
            id: "item_parent_secret",
            clientId: "client_internal_secret",
            content: [],
          },
          {
            type: "collabAgentToolCall",
            id: "collab_item_secret",
            senderThreadId: "sender_internal_secret",
            receiverThreadIds: ["receiver_internal_secret"],
          },
        ],
        startedAt: 1,
        completedAt: 2,
      },
      {
        id: "turn_done_2",
        status: "completed",
        items: [],
        startedAt: 3,
        completedAt: 4,
      },
      {
        id: "turn_active_secret",
        status: "inProgress",
        items: [],
        startedAt: 5,
        completedAt: null,
      },
    ],
    ...overrides,
  };
}

const VALID_MODEL_OUTPUT = JSON.stringify({
  kind: "answer",
  answer: {
    conclusionClaimId: "claim-1",
    claims: [
      {
        id: "claim-1",
        statement: "side_secret parent_secret turn_side_secret turn_done_1 item_parent_secret client_internal_secret sender_internal_secret receiver_internal_secret are internal",
        category: "code_fact",
        evidenceIds: ["evidence-1"],
      },
    ],
    unknowns: [],
  },
});

class FakeBridgeClient implements BridgeAppServerClient {
  initializeCalls = 0;
  readCalls: Array<{ threadId: string; includeTurns: boolean }> = [];
  forkCalls: Array<{
    threadId: string;
    lastTurnId?: string;
    emptyCwd: string;
    developerInstructions: string;
  }> = [];
  projectCalls: Array<{ emptyCwd: string; developerInstructions: string }> = [];
  turnCalls: Array<{ threadId: string; emptyCwd: string; text: string; outputSchema?: unknown }> = [];
  interruptCalls: Array<{ threadId: string; turnId: string }> = [];
  parent = appThread();
  fork = appThread({
    id: "side_secret",
    cwd: EMPTY_CWD,
    ephemeral: true,
    forkedFromId: "parent_secret",
    status: { type: "idle" },
    turns: [],
  });
  project = appThread({
    id: "project_side_secret",
    cwd: EMPTY_CWD,
    ephemeral: true,
    forkedFromId: null,
    status: { type: "idle" },
    turns: [],
  });
  projectThreads: AppServerThread[] = [];
  issuedProjectThreads = new Map<string, AppServerThread>();
  nextEvents: AppServerEvent[][] = [];
  enterTurnResolvers: Array<() => void> = [];
  releaseTurnResolvers: Array<() => void> = [];
  blockingTurnReleases: Promise<void>[] = [];
  turnFailure?: unknown;
  initializeFailure?: unknown;
  forkFailure?: unknown;
  projectFailure?: unknown;
  autoPopulateForkTurns = true;
  isolation: ModelIsolationResult = issueModelIsolationAuthorityForTesting();
  workspaceDigests: string[] = [];
  workspaceDigestCalls: WorkspaceSnapshotRecapturePlan[] = [];
  captureWorkspaceDigestOverride?: (plan: WorkspaceSnapshotRecapturePlan) => Promise<string>;
  sandboxAssertionCalls = 0;
  sandboxFailureOnCall?: number;

  modelIsolationResult(): ModelIsolationResult {
    return this.isolation;
  }

  captureWorkspaceDigest(plan: WorkspaceSnapshotRecapturePlan): Promise<string> {
    this.workspaceDigestCalls.push(plan);
    if (this.captureWorkspaceDigestOverride) return this.captureWorkspaceDigestOverride(plan);
    return Promise.resolve(this.workspaceDigests.shift() ?? SNAPSHOT_DIGEST);
  }

  assertModelSandbox(): Promise<void> {
    this.sandboxAssertionCalls += 1;
    if (this.sandboxAssertionCalls === this.sandboxFailureOnCall) {
      return Promise.reject(new Error("sandbox identity changed C:\\Private\\secret"));
    }
    return Promise.resolve();
  }

  initialize(): Promise<{ userAgent: string; platformFamily: string; platformOs: string }> {
    this.initializeCalls += 1;
    if (this.initializeFailure !== undefined) return Promise.reject(this.initializeFailure);
    return Promise.resolve({
      userAgent: "codex-cli/0.151.0-alpha.7.2",
      platformFamily: "windows",
      platformOs: "windows",
    });
  }

  readThread(threadId: string, includeTurns = false): Promise<AppServerThread> {
    this.readCalls.push({ threadId, includeTurns });
    return Promise.resolve(
      this.issuedProjectThreads.get(threadId) ??
        (threadId === this.project.id ? this.project : this.parent),
    );
  }

  forkEphemeral(input: {
    threadId: string;
    lastTurnId?: string;
    emptyCwd: string;
    developerInstructions: string;
  }): Promise<AppServerThread> {
    this.forkCalls.push(input);
    if (this.forkFailure !== undefined) return Promise.reject(this.forkFailure);
    if (!this.autoPopulateForkTurns) return Promise.resolve(this.fork);
    const cutoffIndex = this.parent.turns.findIndex((turn) => turn.id === input.lastTurnId);
    return Promise.resolve({
      ...this.fork,
      turns: cutoffIndex < 0 ? [] : this.parent.turns.slice(0, cutoffIndex + 1),
    });
  }

  startProjectEphemeralThread(input: {
    emptyCwd: string;
    developerInstructions: string;
  }): Promise<AppServerThread> {
    this.projectCalls.push(input);
    if (this.projectFailure !== undefined) return Promise.reject(this.projectFailure);
    const thread = this.projectThreads.shift() ?? this.project;
    this.issuedProjectThreads.set(thread.id, thread);
    return Promise.resolve(thread);
  }

  async *startTurn(
    input: { threadId: string; emptyCwd: string; text: string; outputSchema?: unknown },
    _signal?: AbortSignal,
  ): AsyncIterable<AppServerEvent> {
    const callIndex = this.turnCalls.length;
    this.turnCalls.push(input);
    this.enterTurnResolvers[callIndex]?.();
    if (this.turnFailure !== undefined) throw this.turnFailure;
    await this.blockingTurnReleases[callIndex];
    for (const event of this.nextEvents.shift() ?? []) yield event;
  }

  interruptTurn(threadId: string, turnId: string): Promise<void> {
    this.interruptCalls.push({ threadId, turnId });
    return Promise.resolve();
  }
}

function opaqueSequence(): () => string {
  let value = 0;
  return () => `opaque-${++value}`;
}

async function collect(events: AsyncIterable<BridgeQuestionEvent>): Promise<BridgeQuestionEvent[]> {
  const values: BridgeQuestionEvent[] = [];
  for await (const event of events) values.push(event);
  return values;
}

function candidate(turnId = "turn_active_secret"): UnverifiedBinding {
  return {
    status: "candidate",
    parentThreadId: "parent_secret",
    parentTurnId: turnId,
    source: "codex-hidden-meta",
  };
}

describe("ContextBridge exact binding", () => {
  it("bounds retained session ownership before creating another side thread", async () => {
    const client = new FakeBridgeClient();
    const bridge = new ContextBridge(client, {
      issueOpaqueId: opaqueSequence(),
      emptyCwd: EMPTY_CWD,
      limits: { maxSessions: 1 },
    });
    const unavailable = {
      status: "unavailable" as const,
      code: "TASK_CONTEXT_UNAVAILABLE" as const,
    };

    await expect(bridge.createSession(
      unavailable,
      "D:\\Project\\Fixture",
      "docs/design.md",
    )).resolves.toMatchObject({ id: "opaque-1" });
    await expect(bridge.createSession(
      unavailable,
      "D:\\Project\\Fixture",
      "docs/second.md",
    )).rejects.toEqual(new ContextBridgeError("BRIDGE_CAPACITY_EXCEEDED"));
    expect(client.projectCalls).toHaveLength(1);
  });

  it("bounds unconsumed verified binding handles before another host read", async () => {
    const client = new FakeBridgeClient();
    const bridge = new ContextBridge(client, {
      issueOpaqueId: opaqueSequence(),
      emptyCwd: EMPTY_CWD,
      limits: { maxVerifiedBindings: 1 },
    });

    await expect(bridge.verifyBinding(candidate(), "D:\\Project\\Fixture"))
      .resolves.toMatchObject({ status: "verified" });
    await expect(bridge.verifyBinding(candidate(), "D:\\Project\\Fixture"))
      .resolves.toEqual({ status: "unavailable", code: "TASK_CONTEXT_UNAVAILABLE" });
    expect(client.readCalls).toHaveLength(1);
  });

  it("fails closed after the observed execution-id budget is exhausted", async () => {
    const client = new FakeBridgeClient();
    client.projectThreads.push(
      appThread({ id: "project-one", cwd: EMPTY_CWD, ephemeral: true, forkedFromId: null, status: { type: "idle" }, turns: [] }),
      appThread({ id: "project-two", cwd: EMPTY_CWD, ephemeral: true, forkedFromId: null, status: { type: "idle" }, turns: [] }),
    );
    const bridge = new ContextBridge(client, {
      issueOpaqueId: opaqueSequence(),
      emptyCwd: EMPTY_CWD,
      limits: { maxSessions: 3, maxObservedExecutionIds: 1 },
    });
    const unavailable = {
      status: "unavailable" as const,
      code: "TASK_CONTEXT_UNAVAILABLE" as const,
    };

    await expect(bridge.createSession(unavailable, "D:\\Project\\Fixture", "docs/one.md"))
      .resolves.toMatchObject({ id: "opaque-1" });
    await expect(bridge.createSession(unavailable, "D:\\Project\\Fixture", "docs/two.md"))
      .rejects.toEqual(new ContextBridgeError("PROJECT_EPHEMERAL_THREAD_INVALID"));
    await expect(bridge.createSession(unavailable, "D:\\Project\\Fixture", "docs/three.md"))
      .rejects.toEqual(new ContextBridgeError("BRIDGE_CAPACITY_EXCEEDED"));
    expect(client.projectCalls).toHaveLength(2);
  });

  it("resolves only the exact candidate thread cwd for internal root narrowing", async () => {
    const client = new FakeBridgeClient();
    const bridge = new ContextBridge(client, {
      issueOpaqueId: opaqueSequence(),
      emptyCwd: EMPTY_CWD,
    });

    await expect(bridge.resolveTaskWorkspace(candidate())).resolves.toEqual({
      status: "resolved",
      workspaceRoot: "D:\\Project\\Fixture",
    });
    await expect(bridge.resolveTaskWorkspace(candidate("turn_missing"))).resolves.toEqual({
      status: "unavailable",
    });
    expect(client.readCalls).toEqual([
      { threadId: "parent_secret", includeTurns: true },
      { threadId: "parent_secret", includeTurns: true },
    ]);
  });

  it("verifies the exact candidate and forks through the latest completed turn", async () => {
    const client = new FakeBridgeClient();
    const bridge = new ContextBridge(client, {
      issueOpaqueId: opaqueSequence(),
      emptyCwd: EMPTY_CWD,
    });

    const binding = await bridge.verifyBinding(candidate(), "D:\\Project\\Fixture");
    expect(binding).toEqual({
      status: "verified",
      bindingId: "opaque-1",
      cutoffLabel: "Through the latest completed parent turn",
    });
    const session = await bridge.createSession(
      binding,
      "D:\\Project\\Fixture",
      "docs/design.md",
    );

    expect(client.initializeCalls).toBe(1);
    expect(client.readCalls).toEqual([{ threadId: "parent_secret", includeTurns: true }]);
    expect(client.forkCalls).toEqual([
      {
        threadId: "parent_secret",
        lastTurnId: "turn_done_2",
        emptyCwd: EMPTY_CWD,
        developerInstructions: SERVER_OWNED_MODEL_POLICY,
      },
    ]);
    expect(session).toMatchObject({
      bindingStatus: "verified",
      contextMode: "task_and_project",
      workspaceLabel: "Fixture",
      documentPath: "docs/design.md",
      cutoffLabel: "Through the latest completed parent turn",
    });
    const serialized = JSON.stringify({ binding, session });
    for (const secret of [
      "parent_secret",
      "turn_done_2",
      "turn_active_secret",
      "side_secret",
      "D:\\\\Project",
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("fails closed when thread/read does not return the exact candidate", async () => {
    const client = new FakeBridgeClient();
    client.parent = appThread({ id: "different_parent" });
    const bridge = new ContextBridge(client, {
      issueOpaqueId: opaqueSequence(),
      emptyCwd: "C:\\Temp\\aimd-empty",
    });
    await expect(
      bridge.verifyBinding(candidate(), "D:\\Project\\Fixture"),
    ).resolves.toEqual({ status: "mismatch", code: "TASK_CONTEXT_MISMATCH" });
    expect(client.readCalls).toHaveLength(1);
  });

  it.each(["parentThreadId", "parentTurnId"] as const)(
    "rejects accessor-shaped %s binding metadata without invoking getters",
    async (accessorKey) => {
      const client = new FakeBridgeClient();
      if (accessorKey === "parentThreadId") {
        client.parent = appThread({ id: "different_parent" });
      }
      const bridge = new ContextBridge(client, {
        issueOpaqueId: opaqueSequence(),
        emptyCwd: EMPTY_CWD,
      });
      let reads = 0;
      const rawBinding = Object.defineProperties({}, {
        status: { enumerable: true, value: "candidate" },
        source: { enumerable: true, value: "codex-hidden-meta" },
        parentThreadId: accessorKey === "parentThreadId"
          ? {
              enumerable: true,
              get() {
                reads += 1;
                return reads === 1 ? "parent_secret" : "different_parent";
              },
            }
          : { enumerable: true, value: "parent_secret" },
        parentTurnId: accessorKey === "parentTurnId"
          ? {
              enumerable: true,
              get() {
                reads += 1;
                return reads === 1 ? "turn_not_in_thread" : "turn_active_secret";
              },
            }
          : { enumerable: true, value: "turn_active_secret" },
      }) as UnverifiedBinding;

      await expect(
        bridge.verifyBinding(rawBinding, "D:\\Project\\Fixture"),
      ).resolves.toEqual({ status: "unavailable", code: "TASK_CONTEXT_UNAVAILABLE" });
      expect(reads).toBe(0);
      expect(client.readCalls).toHaveLength(0);
    },
  );

  it("maps initialization failure to unavailable without leaking host details", async () => {
    const client = new FakeBridgeClient();
    client.initializeFailure = new Error(
      "parent_secret C:\\Users\\hidden private question excerpt",
    );
    const bridge = new ContextBridge(client, {
      issueOpaqueId: opaqueSequence(),
      emptyCwd: "C:\\Temp\\aimd-empty",
    });

    const binding = await bridge.verifyBinding(candidate(), "D:\\Project\\Fixture");

    expect(binding).toEqual({ status: "unavailable", code: "TASK_CONTEXT_UNAVAILABLE" });
    expect(JSON.stringify(binding)).not.toMatch(/parent_secret|Users|private question|excerpt/u);
  });

  it("fails closed when the allowlisted turn candidate is absent from the exact thread", async () => {
    const client = new FakeBridgeClient();
    const bridge = new ContextBridge(client, {
      issueOpaqueId: opaqueSequence(),
      emptyCwd: "C:\\Temp\\aimd-empty",
    });
    await expect(
      bridge.verifyBinding(candidate("turn_not_in_thread"), "D:\\Project\\Fixture"),
    ).resolves.toEqual({ status: "mismatch", code: "TASK_TURN_MISMATCH" });
  });

  it("fails closed when the exact thread workspace differs", async () => {
    const client = new FakeBridgeClient();
    client.parent = appThread({ cwd: "D:\\Project\\Other" });
    const bridge = new ContextBridge(client, {
      issueOpaqueId: opaqueSequence(),
      emptyCwd: "C:\\Temp\\aimd-empty",
    });
    await expect(
      bridge.verifyBinding(candidate(), "D:\\Project\\Fixture"),
    ).resolves.toEqual({ status: "mismatch", code: "TASK_WORKSPACE_MISMATCH" });
  });

  it("does not case-fold a canonical workspace identity at the binding boundary", async () => {
    const client = new FakeBridgeClient();
    client.parent = appThread({ cwd: "D:\\Project\\fixture" });
    const bridge = new ContextBridge(client, {
      issueOpaqueId: opaqueSequence(),
      emptyCwd: EMPTY_CWD,
    });

    await expect(
      bridge.verifyBinding(candidate(), "D:\\Project\\Fixture"),
    ).resolves.toEqual({ status: "mismatch", code: "TASK_WORKSPACE_MISMATCH" });
  });

  it("does not copy an active partial turn when no completed cutoff exists", async () => {
    const client = new FakeBridgeClient();
    client.parent = appThread({
      turns: [
        {
          id: "turn_active_secret",
          status: "inProgress",
          items: [],
          startedAt: 1,
          completedAt: null,
        },
      ],
    });
    const bridge = new ContextBridge(client, {
      issueOpaqueId: opaqueSequence(),
      emptyCwd: "C:\\Temp\\aimd-empty",
    });
    await expect(
      bridge.verifyBinding(candidate(), "D:\\Project\\Fixture"),
    ).resolves.toEqual({ status: "unavailable", code: "NO_COMPLETED_PARENT_TURN" });
    expect(client.forkCalls).toHaveLength(0);
  });

  it("uses authoritative host history order when completedAt is null or non-monotonic", async () => {
    const client = new FakeBridgeClient();
    client.parent = appThread({
      turns: [
        {
          id: "turn_timestamp_newer_but_earlier_in_host_order",
          status: "completed",
          items: [],
          startedAt: 1,
          completedAt: 999,
        },
        {
          id: "turn_latest_in_host_order",
          status: "completed",
          items: [],
          startedAt: null,
          completedAt: null,
        },
        {
          id: "turn_active_secret",
          status: "inProgress",
          items: [],
          startedAt: 1000,
          completedAt: null,
        },
      ],
    });
    const bridge = new ContextBridge(client, {
      issueOpaqueId: opaqueSequence(),
      emptyCwd: "C:\\Temp\\aimd-empty",
    });
    const binding = await bridge.verifyBinding(candidate(), "D:\\Project\\Fixture");
    await bridge.createSession(binding, "D:\\Project\\Fixture", "docs/design.md");
    expect(client.forkCalls).toEqual([
      {
        threadId: "parent_secret",
        lastTurnId: "turn_latest_in_host_order",
        emptyCwd: EMPTY_CWD,
        developerInstructions: SERVER_OWNED_MODEL_POLICY,
      },
    ]);
  });

  it("rejects a fork response that is persistent or not from the exact parent", async () => {
    const client = new FakeBridgeClient();
    client.fork = appThread({
      id: "bad_side",
      ephemeral: false,
      forkedFromId: "other_parent",
      turns: [],
    });
    const bridge = new ContextBridge(client, {
      issueOpaqueId: opaqueSequence(),
      emptyCwd: "C:\\Temp\\aimd-empty",
    });
    const binding = await bridge.verifyBinding(candidate(), "D:\\Project\\Fixture");
    await expect(
      bridge.createSession(binding, "D:\\Project\\Fixture", "docs/design.md"),
    ).rejects.toEqual(new ContextBridgeError("EPHEMERAL_FORK_INVALID"));
  });

  it("rejects an otherwise exact fork that is already active", async () => {
    const client = new FakeBridgeClient();
    client.fork = appThread({
      id: "side_secret",
      ephemeral: true,
      forkedFromId: "parent_secret",
      status: { type: "active" },
      turns: [],
    });
    const bridge = new ContextBridge(client, {
      issueOpaqueId: opaqueSequence(),
      emptyCwd: "C:\\Temp\\aimd-empty",
    });
    const binding = await bridge.verifyBinding(candidate(), "D:\\Project\\Fixture");

    await expect(
      bridge.createSession(binding, "D:\\Project\\Fixture", "docs/design.md"),
    ).rejects.toEqual(new ContextBridgeError("EPHEMERAL_FORK_INVALID"));
  });

  it.each([
    ["missing history", []],
    ["history after the cutoff", appThread().turns],
  ])("rejects a fork whose exact cutoff is unproven: %s", async (_case, turns) => {
    const client = new FakeBridgeClient();
    client.autoPopulateForkTurns = false;
    client.fork = appThread({
      id: "side_secret",
      ephemeral: true,
      forkedFromId: "parent_secret",
      status: { type: "idle" },
      turns,
    });
    const bridge = new ContextBridge(client, {
      issueOpaqueId: opaqueSequence(),
      emptyCwd: "C:\\Temp\\aimd-empty",
    });
    const binding = await bridge.verifyBinding(candidate(), "D:\\Project\\Fixture");

    await expect(
      bridge.createSession(binding, "D:\\Project\\Fixture", "docs/design.md"),
    ).rejects.toEqual(new ContextBridgeError("EPHEMERAL_FORK_INVALID"));
  });
});

describe("ContextBridge session isolation", () => {
  it("rejects accessor-shaped verified binding handles without invoking getters", async () => {
    const client = new FakeBridgeClient();
    const bridge = new ContextBridge(client, {
      issueOpaqueId: opaqueSequence(),
      emptyCwd: EMPTY_CWD,
    });
    const verified = await bridge.verifyBinding(candidate(), "D:\\Project\\Fixture");
    if (verified.status !== "verified") throw new Error("binding fixture failed");
    let reads = 0;
    const accessorBinding = Object.defineProperties({}, {
      status: { enumerable: true, value: "verified" },
      cutoffLabel: { enumerable: true, value: verified.cutoffLabel },
      bindingId: {
        enumerable: true,
        get() {
          reads += 1;
          return verified.bindingId;
        },
      },
    }) as TaskBindingResult;

    await expect(bridge.createSession(
      accessorBinding,
      "D:\\Project\\Fixture",
      "docs/design.md",
    )).rejects.toEqual(new ContextBridgeError("BINDING_HANDLE_INVALID"));
    expect(reads).toBe(0);
    expect(client.forkCalls).toHaveLength(0);
    expect(client.projectCalls).toHaveLength(0);
  });

  it("allows copied parent history but rejects a side-thread id reused across reader sessions", async () => {
    const client = new FakeBridgeClient();
    const bridge = new ContextBridge(client, {
      issueOpaqueId: opaqueSequence(),
      emptyCwd: EMPTY_CWD,
    });
    const binding = await bridge.verifyBinding(candidate(), "D:\\Project\\Fixture");
    await expect(bridge.createSession(
      binding,
      "D:\\Project\\Fixture",
      "docs/design.md",
    )).resolves.toMatchObject({ bindingStatus: "verified" });

    client.fork = { ...client.fork, id: "side_secret_second" };
    await expect(bridge.createSession(
      binding,
      "D:\\Project\\Fixture",
      "docs/second.md",
    )).resolves.toMatchObject({ bindingStatus: "verified" });

    await expect(bridge.createSession(
      binding,
      "D:\\Project\\Fixture",
      "docs/third.md",
    )).rejects.toEqual(new ContextBridgeError("EPHEMERAL_FORK_INVALID"));
    expect(client.forkCalls).toHaveLength(3);
  });

  it("rejects an empty or workspace-overlapping model cwd before creating a side thread", async () => {
    for (const emptyCwd of ["", "D:\\Project\\Fixture\\.aimd-model"]) {
      const client = new FakeBridgeClient();
      const bridge = new ContextBridge(client, {
        issueOpaqueId: opaqueSequence(),
        emptyCwd,
      });

      await expect(bridge.createSession(
        { status: "unavailable", code: "TASK_CONTEXT_UNAVAILABLE" },
        "D:\\Project\\Fixture",
        "docs/design.md",
      )).rejects.toEqual(new ContextBridgeError("MODEL_SANDBOX_UNAVAILABLE"));
      expect(client.projectCalls).toHaveLength(0);
    }
  });

  it("fails closed before side-thread creation when the model sandbox lease cannot be reverified", async () => {
    const client = new FakeBridgeClient();
    client.sandboxFailureOnCall = 1;
    const bridge = new ContextBridge(client, {
      issueOpaqueId: opaqueSequence(),
      emptyCwd: EMPTY_CWD,
    });

    await expect(bridge.createSession(
      { status: "unavailable", code: "TASK_CONTEXT_UNAVAILABLE" },
      "D:\\Project\\Fixture",
      "docs/design.md",
    )).rejects.toEqual(new ContextBridgeError("MODEL_SANDBOX_UNAVAILABLE"));
    expect(client.projectCalls).toHaveLength(0);
  });

  it("creates a clean project-only ephemeral thread for unavailable metadata", async () => {
    const client = new FakeBridgeClient();
    const bridge = new ContextBridge(client, {
      issueOpaqueId: opaqueSequence(),
      emptyCwd: "C:\\Temp\\aimd-empty",
    });
    const binding = await bridge.verifyBinding(
      { status: "unavailable" },
      "D:\\Project\\Fixture",
    );
    const session = await bridge.createSession(
      binding,
      "D:\\Project\\Fixture",
      "docs/design.md",
    );

    expect(binding).toEqual({ status: "unavailable", code: "TASK_CONTEXT_UNAVAILABLE" });
    expect(client.projectCalls).toEqual([
      {
        emptyCwd: EMPTY_CWD,
        developerInstructions: SERVER_OWNED_MODEL_POLICY,
      },
    ]);
    expect(client.forkCalls).toHaveLength(0);
    expect(session).toMatchObject({
      bindingStatus: "unavailable",
      contextMode: "project_only",
      degradationReason: "Task context unavailable; project evidence only",
    });
    expect(JSON.stringify(session)).not.toContain("project_side_secret");
  });

  it("runs a document-only question in a fresh clean thread without inherited project history", async () => {
    const client = new FakeBridgeClient();
    const documentThread = appThread({
      id: "document_side_secret",
      cwd: EMPTY_CWD,
      ephemeral: true,
      forkedFromId: null,
      status: { type: "idle" },
      turns: [],
    });
    client.projectThreads = [client.project, documentThread];
    const documentSnapshot = createWorkspaceSnapshot({
      projectRoot: "D:/Project/Fixture",
      rootId: "root-fixture",
      branch: "main",
      head: "1".repeat(40),
      createdAt: "2026-09-02T00:00:00.000Z",
      gitState: { kind: "clean" },
      relevantFileHashes: [{ path: "docs/design.md", hash: DOCUMENT_HASH }],
    });
    const bridge = new BaseContextBridge(client, {
      issueOpaqueId: opaqueSequence(),
      emptyCwd: EMPTY_CWD,
      workspaceSnapshot: documentSnapshot,
      captureWorkspaceDigest: async () => documentSnapshot.snapshotDigest,
    });
    const binding = await bridge.verifyBinding({ status: "unavailable" }, "D:\\Project\\Fixture");
    const session = await bridge.createSession(binding, "D:\\Project\\Fixture", "docs/design.md");
    const packet = issueEvidencePacket({
      runId: "run-1",
      generation: "generation-1",
      snapshotDigest: documentSnapshot.snapshotDigest,
      sources: [{
        kind: "project_document",
        path: "docs/design.md",
        excerpt: "gateway",
        fileHash: DOCUMENT_HASH,
        sourceLocationKey: "fixture-document",
        startLine: 3,
        endLine: 3,
      }],
    }, { idFactory: (scope) => `${scope}-document` });

    await collect(bridge.ask(session.id, {
      ...anchoredQuestion("Explain this selection", packet),
      contextMode: "document_only",
      snapshotDigest: documentSnapshot.snapshotDigest,
      workspaceSnapshot: documentSnapshot,
    }));

    expect(client.turnCalls).toHaveLength(1);
    expect(client.projectCalls).toHaveLength(2);
    expect(client.turnCalls[0]!.threadId).toBe("document_side_secret");
    expect(client.turnCalls[0]!.threadId).not.toBe("project_side_secret");
    expect(client.readCalls).toContainEqual({
      threadId: "document_side_secret",
      includeTurns: true,
    });
    const envelope = JSON.parse(client.turnCalls[0]!.text) as {
      payload: { contextMode: string };
    };
    expect(envelope.payload.contextMode).toBe("document_only");
  });

  it("fails closed before turn/start when a document-only thread contains history", async () => {
    const client = new FakeBridgeClient();
    client.projectThreads = [client.project, appThread({
      id: "document_dirty_secret",
      cwd: EMPTY_CWD,
      ephemeral: true,
      forkedFromId: null,
      status: { type: "idle" },
      turns: [{
        id: "document_prior_turn_secret",
        status: "completed",
        items: [],
        startedAt: 1,
        completedAt: 2,
      }],
    })];
    const documentSnapshot = createWorkspaceSnapshot({
      projectRoot: "D:/Project/Fixture",
      rootId: "root-fixture",
      branch: "main",
      head: "1".repeat(40),
      createdAt: "2026-09-02T00:00:00.000Z",
      gitState: { kind: "clean" },
      relevantFileHashes: [{ path: "docs/design.md", hash: DOCUMENT_HASH }],
    });
    const bridge = new BaseContextBridge(client, {
      issueOpaqueId: opaqueSequence(),
      emptyCwd: EMPTY_CWD,
      workspaceSnapshot: documentSnapshot,
      captureWorkspaceDigest: async () => documentSnapshot.snapshotDigest,
    });
    const binding = await bridge.verifyBinding({ status: "unavailable" }, "D:\\Project\\Fixture");
    const session = await bridge.createSession(binding, "D:\\Project\\Fixture", "docs/design.md");
    const packet = issueEvidencePacket({
      runId: "run-1",
      generation: "generation-1",
      snapshotDigest: documentSnapshot.snapshotDigest,
      sources: [{
        kind: "project_document",
        path: "docs/design.md",
        excerpt: "gateway",
        fileHash: DOCUMENT_HASH,
        sourceLocationKey: "fixture-document",
        startLine: 3,
        endLine: 3,
      }],
    }, { idFactory: (scope) => `${scope}-document` });

    await expect(collect(bridge.ask(session.id, {
      ...anchoredQuestion("Explain this selection", packet),
      contextMode: "document_only",
      snapshotDigest: documentSnapshot.snapshotDigest,
      workspaceSnapshot: documentSnapshot,
    }))).resolves.toEqual([{ type: "failed", code: "MODEL_ISOLATION_UNPROVEN" }]);
    expect(client.turnCalls).toHaveLength(0);
  });

  it.each([
    {
      name: "prepopulated history",
      project: appThread({
        id: "project_side_secret",
        ephemeral: true,
        forkedFromId: null,
        status: { type: "idle" },
        turns: [{
          id: "preexisting_turn_secret",
          status: "completed",
          items: [],
          startedAt: 1,
          completedAt: 2,
        }],
      }),
    },
    {
      name: "active status",
      project: appThread({
        id: "project_side_secret",
        ephemeral: true,
        forkedFromId: null,
        status: { type: "active" },
        turns: [],
      }),
    },
  ])("rejects a project-only thread with $name", async ({ project }) => {
    const client = new FakeBridgeClient();
    client.project = project;
    const bridge = new ContextBridge(client, {
      issueOpaqueId: opaqueSequence(),
      emptyCwd: "C:\\Temp\\aimd-empty",
    });

    await expect(bridge.createSession(
      { status: "unavailable", code: "TASK_CONTEXT_UNAVAILABLE" },
      "D:\\Project\\Fixture",
      "docs/design.md",
    )).rejects.toEqual(new ContextBridgeError("PROJECT_EPHEMERAL_THREAD_INVALID"));
  });

  it("returns a fixed failure when no clean ephemeral App Server thread can be created", async () => {
    const client = new FakeBridgeClient();
    client.projectFailure = new Error(
      "project_side_secret C:\\Users\\hidden private question excerpt",
    );
    const bridge = new ContextBridge(client, {
      issueOpaqueId: opaqueSequence(),
      emptyCwd: "C:\\Temp\\aimd-empty",
    });

    await expect(
      bridge.createSession(
        { status: "unavailable", code: "TASK_CONTEXT_UNAVAILABLE" },
        "D:\\Project\\Fixture",
        "docs/design.md",
      ),
    ).rejects.toEqual(new ContextBridgeError("TASK_CONTEXT_UNAVAILABLE"));
  });

  it("returns a fixed failure instead of falling back when the exact fork fails", async () => {
    const client = new FakeBridgeClient();
    client.forkFailure = new Error(
      "parent_secret C:\\Users\\hidden private question excerpt",
    );
    const bridge = new ContextBridge(client, {
      issueOpaqueId: opaqueSequence(),
      emptyCwd: "C:\\Temp\\aimd-empty",
    });
    const binding = await bridge.verifyBinding(candidate(), "D:\\Project\\Fixture");

    await expect(
      bridge.createSession(binding, "D:\\Project\\Fixture", "docs/design.md"),
    ).rejects.toEqual(new ContextBridgeError("TASK_CONTEXT_UNAVAILABLE"));
    expect(client.projectCalls).toHaveLength(0);
  });

  it("reuses one side thread for follow-ups and redacts all internal ids", async () => {
    const client = new FakeBridgeClient();
    client.nextEvents = [
      [
        { type: "started", turnId: "turn_side_secret" },
        { type: "text_delta", text: VALID_MODEL_OUTPUT },
        {
          type: "completed",
          turn: {
            id: "turn_side_secret",
            status: "completed",
            items: [],
            startedAt: 10,
            completedAt: 11,
          },
        },
      ],
      [
        { type: "started", turnId: "turn_followup_secret" },
        { type: "text_delta", text: VALID_MODEL_OUTPUT },
        {
          type: "completed",
          turn: {
            id: "turn_followup_secret",
            status: "completed",
            items: [],
            startedAt: 12,
            completedAt: 13,
          },
        },
      ],
    ];
    const bridge = new ContextBridge(client, {
      issueOpaqueId: opaqueSequence(),
      emptyCwd: EMPTY_CWD,
    });
    const binding = await bridge.verifyBinding(candidate(), "D:\\Project\\Fixture");
    const session = await bridge.createSession(
      binding,
      "D:\\Project\\Fixture",
      "docs/design.md",
    );

    const first = await collect(
      bridge.ask(session.id, anchoredQuestion("first")),
    );
    const second = await collect(
      bridge.ask(session.id, anchoredQuestion("follow up")),
    );

    expect(client.forkCalls).toHaveLength(1);
    expect(client.turnCalls.map((call) => call.threadId)).toEqual([
      "side_secret",
      "side_secret",
    ]);
    expect(client.turnCalls.every((call) => call.emptyCwd === "C:\\Temp\\aimd-empty")).toBe(true);
    const firstEnvelope = JSON.parse(client.turnCalls[0]!.text) as {
      operation: string;
      payload: Record<string, unknown>;
    };
    expect(firstEnvelope).toMatchObject({
      operation: "question",
      payload: {
        documentPath: "docs/design.md",
        runId: "run-1",
        generation: "generation-1",
        snapshotDigest: SNAPSHOT_DIGEST,
      },
    });
    expect(firstEnvelope).not.toHaveProperty("policy");
    expect(client.turnCalls[0]!.text).not.toContain(SERVER_OWNED_MODEL_POLICY);
    expect(client.turnCalls.every((call) => call.outputSchema !== undefined)).toBe(true);
    expect(client.workspaceDigestCalls).toEqual(Array.from({ length: 4 }, () => ({
      projectRoot: "D:/Project/Fixture",
      rootId: "root-fixture",
      relevantPaths: ["src/gateway.ts"],
      snapshotDigest: SNAPSHOT_DIGEST,
    })));
    const serialized = JSON.stringify({ first, second });
    for (const secret of [
      "parent_secret",
      "side_secret",
      "turn_side_secret",
      "turn_followup_secret",
    ]) {
      expect(serialized).not.toContain(secret);
    }
    expect(first.at(-1)).toMatchObject({ type: "completed", output: { kind: "answer" } });
  });

  it("serializes overlapping questions within one reader session", async () => {
    const client = new FakeBridgeClient();
    const entered = [
      new Promise<void>((resolve) => { client.enterTurnResolvers.push(resolve); }),
      new Promise<void>((resolve) => { client.enterTurnResolvers.push(resolve); }),
    ];
    const releases = [
      new Promise<void>((resolve) => { client.releaseTurnResolvers.push(resolve); }),
      new Promise<void>((resolve) => { client.releaseTurnResolvers.push(resolve); }),
    ];
    client.blockingTurnReleases = releases;
    const bridge = new ContextBridge(client, {
      issueOpaqueId: opaqueSequence(),
      emptyCwd: EMPTY_CWD,
    });
    const binding = await bridge.verifyBinding(candidate(), "D:\\Project\\Fixture");
    const session = await bridge.createSession(binding, "D:\\Project\\Fixture", "docs/design.md");

    const first = collect(bridge.ask(session.id, anchoredQuestion("first")));
    await entered[0];
    const second = collect(bridge.ask(session.id, anchoredQuestion("second")));
    const secondState = await Promise.race([
      entered[1]!.then(() => "entered" as const),
      new Promise<"pending">((resolve) => setImmediate(() => resolve("pending"))),
    ]);

    expect(secondState).toBe("pending");
    expect(client.turnCalls).toHaveLength(1);
    client.releaseTurnResolvers[0]!();
    await entered[1];
    expect(client.turnCalls).toHaveLength(2);
    client.releaseTurnResolvers[1]!();
    await Promise.all([first, second]);
  });

  it("allows questions from different reader sessions to run in parallel", async () => {
    const client = new FakeBridgeClient();
    const entered = [
      new Promise<void>((resolve) => { client.enterTurnResolvers.push(resolve); }),
      new Promise<void>((resolve) => { client.enterTurnResolvers.push(resolve); }),
    ];
    const releases = [
      new Promise<void>((resolve) => { client.releaseTurnResolvers.push(resolve); }),
      new Promise<void>((resolve) => { client.releaseTurnResolvers.push(resolve); }),
    ];
    client.blockingTurnReleases = releases;
    const bridge = new ContextBridge(client, {
      issueOpaqueId: opaqueSequence(),
      emptyCwd: EMPTY_CWD,
    });
    const binding = await bridge.verifyBinding(candidate(), "D:\\Project\\Fixture");
    const firstSession = await bridge.createSession(binding, "D:\\Project\\Fixture", "docs/design.md");
    client.fork = { ...client.fork, id: "side_second_secret" };
    const secondSession = await bridge.createSession(binding, "D:\\Project\\Fixture", "docs/second.md");

    const first = collect(bridge.ask(firstSession.id, anchoredQuestion("first")));
    const second = collect(bridge.ask(secondSession.id, {
      ...anchoredQuestion("second"),
      sourceAnchor: {
        ...anchoredQuestion("second").sourceAnchor,
        documentPath: "docs/second.md",
      },
    }));
    await Promise.all(entered);

    expect(client.turnCalls).toHaveLength(2);
    expect(new Set(client.turnCalls.map(({ threadId }) => threadId))).toEqual(
      new Set(["side_secret", "side_second_secret"]),
    );
    client.releaseTurnResolvers[0]!();
    client.releaseTurnResolvers[1]!();
    await Promise.all([first, second]);
  });

  it("does not leak an internal id split across streamed deltas", async () => {
    const client = new FakeBridgeClient();
    const splitAt = VALID_MODEL_OUTPUT.indexOf("side_secret") + "side_".length;
    client.nextEvents = [[
      { type: "started", turnId: "turn_side_secret" },
      { type: "text_delta", text: VALID_MODEL_OUTPUT.slice(0, splitAt) },
      { type: "text_delta", text: VALID_MODEL_OUTPUT.slice(splitAt) },
      { type: "completed", turn: { id: "turn_side_secret", status: "completed", items: [], startedAt: 1, completedAt: 2 } },
    ]];
    const bridge = new ContextBridge(client, {
      issueOpaqueId: opaqueSequence(), emptyCwd: EMPTY_CWD,
    });
    const binding = await bridge.verifyBinding(candidate(), "D:\\Project\\Fixture");
    const session = await bridge.createSession(binding, "D:\\Project\\Fixture", "docs/design.md");
    const events = await collect(bridge.ask(session.id, anchoredQuestion("split")));
    expect(events.every((event) => event.type !== ("text_delta" as never))).toBe(true);
    expect(JSON.stringify(events)).not.toContain("turn_side_secret");
    expect(events.at(-1)).toMatchObject({ type: "completed" });
  });

  it.each([
    "The implementation is at C:\\Users\\name\\project\\src\\gateway.ts:10.",
    "path=C:/Users/private/project/src/gateway.ts:10",
    "[C:/Users/private/project/src/gateway.ts:10]",
    ">C:/Users/private/project/src/gateway.ts:10",
    ",C:/Users/private/project/src/gateway.ts:10",
    "path=C%253A%252FUsers%252Fprivate%252Fproject%252Fsrc%252Fgateway.ts%253A10",
    "path=C%25253A%25255CUsers%25255Cprivate%25255Cproject%25255Csrc%25255Cgateway.ts%25253A10",
    "path=C%3A%5CUsers%5Cprivate%5Cproject%5Csrc%5Cgateway.ts%ZZ",
    Array.from({ length: 12 }, () => 0).reduce<string>(
      (encoded) => encodeURIComponent(encoded),
      "C:\\Users\\private\\project\\src\\gateway.ts:10",
    ),
    "/README.md",
    "Render </etc/passwd> as text.",
    "C:∕Users∕private∕project∕src∕gateway.ts:10",
    "See src/gateway.ts:10-12 for the implementation.",
    "Open file:///D:/Project/Fixture/src/gateway.ts#L10.",
  ])("rejects raw model-authored source locations before public output: %s", async (statement) => {
    const client = new FakeBridgeClient();
    const output = JSON.parse(VALID_MODEL_OUTPUT) as {
      answer: { claims: Array<{ statement: string }> };
    };
    output.answer.claims[0]!.statement = statement;
    client.nextEvents = [[
      { type: "started", turnId: "turn_side_secret" },
      { type: "text_delta", text: JSON.stringify(output) },
      {
        type: "completed",
        turn: {
          id: "turn_side_secret",
          status: "completed",
          items: [],
          startedAt: 1,
          completedAt: 2,
        },
      },
    ]];
    const bridge = new ContextBridge(client, {
      issueOpaqueId: opaqueSequence(), emptyCwd: EMPTY_CWD,
    });
    const binding = await bridge.verifyBinding(candidate(), "D:\\Project\\Fixture");
    const session = await bridge.createSession(binding, "D:\\Project\\Fixture", "docs/design.md");

    const events = await collect(bridge.ask(session.id, anchoredQuestion("locations")));

    expect(events.at(-1)).toEqual({ type: "failed", code: "MODEL_OUTPUT_INVALID" });
    expect(JSON.stringify(events)).not.toContain(statement);
  });

  it.each([
    "Use read / write mode.",
    "The ratio is 1 / 2.",
    "Render </code> literally.",
    "Progress is 100% complete.",
  ])("does not mistake a standalone slash for a source location: %s", async (statement) => {
    const client = new FakeBridgeClient();
    const output = JSON.parse(VALID_MODEL_OUTPUT) as {
      answer: { claims: Array<{ statement: string }> };
    };
    output.answer.claims[0]!.statement = statement;
    client.nextEvents = [[
      { type: "started", turnId: "turn_side_secret" },
      { type: "text_delta", text: JSON.stringify(output) },
      {
        type: "completed",
        turn: {
          id: "turn_side_secret",
          status: "completed",
          items: [],
          startedAt: 1,
          completedAt: 2,
        },
      },
    ]];
    const bridge = new ContextBridge(client, {
      issueOpaqueId: opaqueSequence(), emptyCwd: EMPTY_CWD,
    });
    const binding = await bridge.verifyBinding(candidate(), "D:\\Project\\Fixture");
    const session = await bridge.createSession(binding, "D:\\Project\\Fixture", "docs/design.md");

    const events = await collect(bridge.ask(session.id, anchoredQuestion("slash prose")));

    expect(events.at(-1)).toMatchObject({ type: "completed" });
  });

  it("redacts decoded escaped ids and every parent turn/item id after JSON parsing", async () => {
    const client = new FakeBridgeClient();
    const escapedOutput = VALID_MODEL_OUTPUT
      .replace("parent_secret", "parent_\\u0073ecret")
      .replace("turn_done_1", "turn_done_\\u0031")
      .replace("item_parent_secret", "item_parent_\\u0073ecret")
      .replace("client_internal_secret", "client_internal_\\u0073ecret")
      .replace("sender_internal_secret", "sender_internal_\\u0073ecret")
      .replace("receiver_internal_secret", "receiver_internal_\\u0073ecret");
    client.nextEvents = [[
      { type: "started", turnId: "turn_side_secret" },
      { type: "text_delta", text: escapedOutput },
      {
        type: "completed",
        turn: {
          id: "turn_side_secret",
          status: "completed",
          items: [],
          startedAt: 1,
          completedAt: 2,
        },
      },
    ]];
    const bridge = new ContextBridge(client, {
      issueOpaqueId: opaqueSequence(),
      emptyCwd: EMPTY_CWD,
    });
    const binding = await bridge.verifyBinding(candidate(), "D:\\Project\\Fixture");
    const session = await bridge.createSession(
      binding,
      "D:\\Project\\Fixture",
      "docs/design.md",
    );

    const events = await collect(
      bridge.ask(session.id, anchoredQuestion("escaped ids")),
    );

    expect(events.at(-1)).toMatchObject({ type: "completed" });
    const serialized = JSON.stringify(events);
    for (const secret of [
      "parent_secret",
      "turn_done_1",
      "turn_done_2",
      "turn_active_secret",
      "item_parent_secret",
      "client_internal_secret",
      "sender_internal_secret",
      "receiver_internal_secret",
      "side_secret",
      "turn_side_secret",
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("interrupts and rejects model output before buffering more than one MiB of UTF-8", async () => {
    const client = new FakeBridgeClient();
    client.nextEvents = [[
      { type: "started", turnId: "turn_side_secret" },
      { type: "text_delta", text: `{"kind":"${"a".repeat(600_000)}` },
      { type: "text_delta", text: "b".repeat(600_000) },
    ]];
    const bridge = new ContextBridge(client, {
      issueOpaqueId: opaqueSequence(),
      emptyCwd: EMPTY_CWD,
    });
    const binding = await bridge.verifyBinding(candidate(), "D:\\Project\\Fixture");
    const session = await bridge.createSession(
      binding,
      "D:\\Project\\Fixture",
      "docs/design.md",
    );

    await expect(
      collect(bridge.ask(session.id, anchoredQuestion("bounded"))),
    ).resolves.toEqual([
      { type: "progress", phase: "started" },
      { type: "failed", code: "MODEL_OUTPUT_INVALID" },
    ]);
    expect(client.interruptCalls).toEqual([
      { threadId: "side_secret", turnId: "turn_side_secret" },
    ]);
  });

  it("rejects a JSON-copied evidence packet before starting a model turn", async () => {
    const client = new FakeBridgeClient();
    const bridge = new ContextBridge(client, {
      issueOpaqueId: opaqueSequence(),
      emptyCwd: EMPTY_CWD,
    });
    const binding = await bridge.verifyBinding(candidate(), "D:\\Project\\Fixture");
    const session = await bridge.createSession(binding, "D:\\Project\\Fixture", "docs/design.md");
    const copied = JSON.parse(JSON.stringify(issuedPacket())) as EvidencePacket;

    await expect(
      collect(bridge.ask(session.id, anchoredQuestion("copied", copied))),
    ).resolves.toEqual([{ type: "failed", code: "QUESTION_PACKET_INVALID" }]);
    expect(client.turnCalls).toHaveLength(0);
    expect(client.workspaceDigestCalls).toHaveLength(0);
  });

  it("rejects a copied workspace snapshot handle before recapture or model execution", async () => {
    const client = new FakeBridgeClient();
    const bridge = new ContextBridge(client, {
      issueOpaqueId: opaqueSequence(),
      emptyCwd: EMPTY_CWD,
    });
    const binding = await bridge.verifyBinding(candidate(), "D:\\Project\\Fixture");
    const session = await bridge.createSession(binding, "D:\\Project\\Fixture", "docs/design.md");
    const question = anchoredQuestion("copied snapshot");

    await expect(collect(bridge.ask(session.id, {
      ...question,
      workspaceSnapshot: JSON.parse(JSON.stringify(WORKSPACE_SNAPSHOT)),
    }))).resolves.toEqual([{ type: "failed", code: "QUESTION_PACKET_INVALID" }]);
    expect(client.workspaceDigestCalls).toHaveLength(0);
    expect(client.turnCalls).toHaveLength(0);
  });

  it.each(["question", "anchor"] as const)(
    "rejects accessor-shaped %s input without invoking getters",
    async (accessorLocation) => {
      const client = new FakeBridgeClient();
      const bridge = new ContextBridge(client, {
        issueOpaqueId: opaqueSequence(),
        emptyCwd: EMPTY_CWD,
      });
      const binding = await bridge.verifyBinding(candidate(), "D:\\Project\\Fixture");
      const session = await bridge.createSession(
        binding,
        "D:\\Project\\Fixture",
        "docs/design.md",
      );
      const baseQuestion = anchoredQuestion("accessor input");
      let reads = 0;
      let unsafeQuestion: AnchoredQuestion;

      if (accessorLocation === "question") {
        const descriptors = Object.getOwnPropertyDescriptors(baseQuestion);
        descriptors.runId = {
          enumerable: true,
          configurable: true,
          get() {
            reads += 1;
            return reads === 1 ? "run-1" : "run-2";
          },
        };
        unsafeQuestion = Object.defineProperties({}, descriptors) as AnchoredQuestion;
      } else {
        const descriptors = Object.getOwnPropertyDescriptors(baseQuestion.sourceAnchor);
        descriptors.selectedText = {
          enumerable: true,
          configurable: true,
          get() {
            reads += 1;
            return reads === 1 ? "gateway" : "different";
          },
        };
        unsafeQuestion = {
          ...baseQuestion,
          sourceAnchor: Object.defineProperties({}, descriptors) as AnchoredQuestion["sourceAnchor"],
        };
      }

      await expect(collect(bridge.ask(session.id, unsafeQuestion))).resolves.toEqual([
        { type: "failed", code: "QUESTION_PACKET_INVALID" },
      ]);
      expect(reads).toBe(0);
      expect(client.workspaceDigestCalls).toHaveLength(0);
      expect(client.turnCalls).toHaveLength(0);
    },
  );

  it("rejects a live snapshot from another workspace instance at the same path", async () => {
    const otherWorkspaceSnapshot = createWorkspaceSnapshot({
      projectRoot: "D:/Project/Fixture",
      rootId: "root-other-instance",
      branch: "main",
      head: "1".repeat(40),
      createdAt: "2026-09-02T00:00:00.000Z",
      gitState: {
        kind: "dirty",
        status: " M src/gateway.ts",
        contentDigest: sha256Text("bridge fixture dirty state"),
      },
      relevantFileHashes: [{ path: "src/gateway.ts", hash: sha256Text(GATEWAY_TEXT) }],
    });
    expect(otherWorkspaceSnapshot.snapshotDigest).toBe(SNAPSHOT_DIGEST);
    const client = new FakeBridgeClient();
    client.nextEvents = [[
      { type: "started", turnId: "turn_side_secret" },
      { type: "text_delta", text: VALID_MODEL_OUTPUT },
      { type: "completed", turn: { id: "turn_side_secret", status: "completed", items: [], startedAt: 1, completedAt: 2 } },
    ]];
    const bridge = new ContextBridge(client, {
      issueOpaqueId: opaqueSequence(),
      emptyCwd: EMPTY_CWD,
    });
    const binding = await bridge.verifyBinding(candidate(), "D:\\Project\\Fixture");
    const session = await bridge.createSession(binding, "D:\\Project\\Fixture", "docs/design.md");
    const question = anchoredQuestion("wrong workspace instance");

    await expect(collect(bridge.ask(session.id, {
      ...question,
      workspaceSnapshot: otherWorkspaceSnapshot,
    }))).resolves.toEqual([{ type: "failed", code: "QUESTION_PACKET_INVALID" }]);
    expect(client.workspaceDigestCalls).toHaveLength(0);
    expect(client.turnCalls).toHaveLength(0);
  });

  it("discards a completed answer and permanently disables execution when the workspace changes", async () => {
    const client = new FakeBridgeClient();
    client.workspaceDigests = [SNAPSHOT_DIGEST, "e".repeat(64)];
    client.nextEvents = [[
      { type: "started", turnId: "turn_side_secret" },
      { type: "text_delta", text: VALID_MODEL_OUTPUT },
      {
        type: "completed",
        turn: {
          id: "turn_side_secret",
          status: "completed",
          items: [],
          startedAt: 1,
          completedAt: 2,
        },
      },
    ]];
    const bridge = new ContextBridge(client, {
      issueOpaqueId: opaqueSequence(),
      emptyCwd: EMPTY_CWD,
    });
    const binding = await bridge.verifyBinding(candidate(), "D:\\Project\\Fixture");
    const session = await bridge.createSession(binding, "D:\\Project\\Fixture", "docs/design.md");

    await expect(
      collect(bridge.ask(session.id, anchoredQuestion("mutated"))),
    ).resolves.toEqual([
      { type: "progress", phase: "started" },
      { type: "failed", code: "READ_ONLY_INVARIANT_BROKEN" },
    ]);
    await expect(
      collect(bridge.ask(session.id, anchoredQuestion("again"))),
    ).resolves.toEqual([{ type: "failed", code: "READ_ONLY_INVARIANT_BROKEN" }]);
    expect(client.turnCalls).toHaveLength(1);
  });

  it("discards a completed answer and disables future execution when the model sandbox changes", async () => {
    const client = new FakeBridgeClient();
    client.nextEvents = [[
      { type: "started", turnId: "turn_side_secret" },
      { type: "text_delta", text: VALID_MODEL_OUTPUT },
      {
        type: "completed",
        turn: {
          id: "turn_side_secret",
          status: "completed",
          items: [],
          startedAt: 1,
          completedAt: 2,
        },
      },
    ]];
    const bridge = new ContextBridge(client, {
      issueOpaqueId: opaqueSequence(),
      emptyCwd: EMPTY_CWD,
    });
    const binding = await bridge.verifyBinding(candidate(), "D:\\Project\\Fixture");
    const session = await bridge.createSession(binding, "D:\\Project\\Fixture", "docs/design.md");
    client.sandboxFailureOnCall = client.sandboxAssertionCalls + 2;

    await expect(collect(bridge.ask(session.id, anchoredQuestion("first")))).resolves.toEqual([
      { type: "progress", phase: "started" },
      { type: "failed", code: "MODEL_ISOLATION_BROKEN" },
    ]);
    await expect(collect(bridge.ask(session.id, anchoredQuestion("second")))).resolves.toEqual([
      { type: "failed", code: "MODEL_ISOLATION_BROKEN" },
    ]);
  });

  it("reports a stale pre-turn snapshot without blaming or permanently disabling the model", async () => {
    const client = new FakeBridgeClient();
    client.workspaceDigests = ["d".repeat(64), SNAPSHOT_DIGEST, SNAPSHOT_DIGEST];
    client.nextEvents = [[
      { type: "started", turnId: "turn_retry_secret" },
      { type: "text_delta", text: VALID_MODEL_OUTPUT },
      {
        type: "completed",
        turn: { id: "turn_retry_secret", status: "completed", items: [], startedAt: 1, completedAt: 2 },
      },
    ]];
    const bridge = new ContextBridge(client, {
      issueOpaqueId: opaqueSequence(),
      emptyCwd: EMPTY_CWD,
    });
    const binding = await bridge.verifyBinding(candidate(), "D:\\Project\\Fixture");
    const session = await bridge.createSession(binding, "D:\\Project\\Fixture", "docs/design.md");

    await expect(
      collect(bridge.ask(session.id, anchoredQuestion("stale"))),
    ).resolves.toEqual([{ type: "failed", code: "WORKSPACE_SNAPSHOT_STALE" }]);
    await expect(
      collect(bridge.ask(session.id, anchoredQuestion("fresh retry"))),
    ).resolves.toEqual([
      { type: "progress", phase: "started" },
      expect.objectContaining({ type: "completed" }),
    ]);
    expect(client.turnCalls).toHaveLength(1);
  });

  it("does not send turn/start when cancellation arrives during pre-turn snapshot capture", async () => {
    const client = new FakeBridgeClient();
    let markCaptureStarted!: () => void;
    let releaseCapture!: () => void;
    const captureStarted = new Promise<void>((resolve) => { markCaptureStarted = resolve; });
    const captureReleased = new Promise<void>((resolve) => { releaseCapture = resolve; });
    client.captureWorkspaceDigestOverride = async () => {
      markCaptureStarted();
      await captureReleased;
      return SNAPSHOT_DIGEST;
    };
    const bridge = new ContextBridge(client, {
      issueOpaqueId: opaqueSequence(),
      emptyCwd: EMPTY_CWD,
    });
    const binding = await bridge.verifyBinding(candidate(), "D:\\Project\\Fixture");
    const session = await bridge.createSession(binding, "D:\\Project\\Fixture", "docs/design.md");
    const controller = new AbortController();
    const running = collect(bridge.ask(session.id, anchoredQuestion("cancel preflight"), controller.signal));
    await captureStarted;

    controller.abort();
    releaseCapture();

    await expect(running).resolves.toEqual([{ type: "cancelled" }]);
    expect(client.turnCalls).toHaveLength(0);
  });

  it("checks the post-turn snapshot even when the caller stops consuming after start", async () => {
    const client = new FakeBridgeClient();
    client.nextEvents = [[{ type: "started", turnId: "turn_side_secret" }]];
    const bridge = new ContextBridge(client, {
      issueOpaqueId: opaqueSequence(),
      emptyCwd: EMPTY_CWD,
    });
    const binding = await bridge.verifyBinding(candidate(), "D:\\Project\\Fixture");
    const session = await bridge.createSession(binding, "D:\\Project\\Fixture", "docs/design.md");
    const iterator = bridge.ask(session.id, anchoredQuestion("stop early"))[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toEqual({
      value: { type: "progress", phase: "started" },
      done: false,
    });
    await iterator.return?.();
    expect(client.workspaceDigestCalls).toEqual(Array.from({ length: 2 }, () => ({
      projectRoot: "D:/Project/Fixture",
      rootId: "root-fixture",
      relevantPaths: ["src/gateway.ts"],
      snapshotDigest: SNAPSHOT_DIGEST,
    })));
  });

  it("rejects model-minted and task-decision citations before returning a candidate", async () => {
    const client = new FakeBridgeClient();
    client.nextEvents = [[
      { type: "started", turnId: "turn_side_secret" },
      {
        type: "text_delta",
        text: JSON.stringify({
          kind: "answer",
          answer: {
            conclusionClaimId: "claim-1",
            claims: [{
              id: "claim-1",
              statement: "The parent task chose this design.",
              category: "task_decision",
              evidenceIds: ["evidence-1"],
            }],
            unknowns: [],
          },
        }),
      },
      {
        type: "completed",
        turn: { id: "turn_side_secret", status: "completed", items: [], startedAt: 1, completedAt: 2 },
      },
    ]];
    const bridge = new ContextBridge(client, {
      issueOpaqueId: opaqueSequence(),
      emptyCwd: EMPTY_CWD,
    });
    const binding = await bridge.verifyBinding(candidate(), "D:\\Project\\Fixture");
    const session = await bridge.createSession(binding, "D:\\Project\\Fixture", "docs/design.md");

    await expect(
      collect(bridge.ask(session.id, anchoredQuestion("why"))),
    ).resolves.toEqual([
      { type: "progress", phase: "started" },
      { type: "failed", code: "MODEL_OUTPUT_INVALID" },
    ]);
  });

  it("stays reader-only when the effective model tool surface is unproven", async () => {
    const client = new FakeBridgeClient();
    client.isolation = {
      status: "reader_only",
      code: "MODEL_ISOLATION_UNPROVEN",
      missing: ["effectiveTools.hostAttestation"],
    };
    const bridge = new ContextBridge(client, {
      issueOpaqueId: opaqueSequence(),
      emptyCwd: "C:\\Temp\\aimd-empty",
    });
    const binding = await bridge.verifyBinding(candidate(), "D:\\Project\\Fixture");
    const session = await bridge.createSession(
      binding,
      "D:\\Project\\Fixture",
      "docs/design.md",
    );
    await expect(
      collect(bridge.ask(session.id, anchoredQuestion("blocked"))),
    ).resolves.toEqual([{ type: "failed", code: "MODEL_ISOLATION_UNPROVEN" }]);
    expect(client.turnCalls).toHaveLength(0);
  });

  it("interrupts and permanently disables model execution after a tool event", async () => {
    const client = new FakeBridgeClient();
    client.nextEvents = [[
      { type: "started", turnId: "turn_side_secret" },
      {
        type: "item",
        phase: "started",
        item: { type: "mcpToolCall", server: "private", tool: "read" },
      },
    ]];
    const bridge = new ContextBridge(client, {
      issueOpaqueId: opaqueSequence(),
      emptyCwd: EMPTY_CWD,
    });
    const binding = await bridge.verifyBinding(candidate(), "D:\\Project\\Fixture");
    const session = await bridge.createSession(
      binding,
      "D:\\Project\\Fixture",
      "docs/design.md",
    );
    await expect(
      collect(bridge.ask(session.id, anchoredQuestion("adversarial"))),
    ).resolves.toEqual([
      { type: "progress", phase: "started" },
      { type: "failed", code: "TOOL_ISOLATION_BROKEN" },
    ]);
    expect(client.interruptCalls).toEqual([
      { threadId: "side_secret", turnId: "turn_side_secret" },
    ]);
    await expect(
      collect(bridge.ask(session.id, anchoredQuestion("again"))),
    ).resolves.toEqual([{ type: "failed", code: "TOOL_ISOLATION_BROKEN" }]);
  });

  it.each(["mcpToolCall", "futureToolClass"])(
    "inspects terminal turn items and globally disables on %s",
    async (itemType) => {
      const client = new FakeBridgeClient();
      client.nextEvents = [[
        { type: "started", turnId: "turn_side_secret" },
        { type: "text_delta", text: VALID_MODEL_OUTPUT },
        {
          type: "completed",
          turn: {
            id: "turn_side_secret",
            status: "completed",
            items: [{ type: itemType, id: "terminal_item_secret" }],
            startedAt: 1,
            completedAt: 2,
          },
        },
      ]];
      const bridge = new ContextBridge(client, {
        issueOpaqueId: opaqueSequence(),
        emptyCwd: EMPTY_CWD,
      });
      const binding = await bridge.verifyBinding(candidate(), "D:\\Project\\Fixture");
      const session = await bridge.createSession(
        binding,
        "D:\\Project\\Fixture",
        "docs/design.md",
      );

      await expect(
        collect(bridge.ask(session.id, anchoredQuestion("terminal"))),
      ).resolves.toEqual([
        { type: "progress", phase: "started" },
        { type: "failed", code: "TOOL_ISOLATION_BROKEN" },
      ]);
      expect(client.interruptCalls).toEqual([
        { threadId: "side_secret", turnId: "turn_side_secret" },
      ]);
      await expect(
        collect(bridge.ask(session.id, anchoredQuestion("again"))),
      ).resolves.toEqual([{ type: "failed", code: "TOOL_ISOLATION_BROKEN" }]);
    },
  );

  it("maps an App Server restart exception to one sanitized terminal failure", async () => {
    const client = new FakeBridgeClient();
    client.turnFailure = Object.assign(
      new Error("thr_secret C:\\Users\\private question excerpt"),
      { code: "APP_SERVER_EXITED" },
    );
    const bridge = new ContextBridge(client, {
      issueOpaqueId: opaqueSequence(),
      emptyCwd: EMPTY_CWD,
    });
    const binding = await bridge.verifyBinding(candidate(), "D:\\Project\\Fixture");
    const session = await bridge.createSession(binding, "D:\\Project\\Fixture", "docs/design.md");
    const events = await collect(bridge.ask(session.id, anchoredQuestion("restart")));
    expect(events).toEqual([{ type: "failed", code: "APP_SERVER_RESTARTED" }]);
    await expect(
      collect(bridge.ask(session.id, anchoredQuestion("retry"))),
    ).resolves.toEqual([{ type: "failed", code: "APP_SERVER_RESTARTED" }]);
    expect(client.turnCalls).toHaveLength(1);
    const serialized = JSON.stringify(events);
    for (const secret of ["thr_secret", "Users", "private question", "excerpt"]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("emits a fixed failure when the App Server stream ends without a terminal", async () => {
    const client = new FakeBridgeClient();
    client.nextEvents = [[{ type: "started", turnId: "turn_side_secret" }]];
    const bridge = new ContextBridge(client, {
      issueOpaqueId: opaqueSequence(),
      emptyCwd: EMPTY_CWD,
    });
    const binding = await bridge.verifyBinding(candidate(), "D:\\Project\\Fixture");
    const session = await bridge.createSession(binding, "D:\\Project\\Fixture", "docs/design.md");
    await expect(
      collect(bridge.ask(session.id, anchoredQuestion("no terminal"))),
    ).resolves.toEqual([
      { type: "progress", phase: "started" },
      { type: "failed", code: "APP_SERVER_TURN_TERMINATED" },
    ]);
  });

  it("runs evidence audit in a separate clean thread and validates exact claim/evidence binding", async () => {
    const client = new FakeBridgeClient();
    const bridge = new ContextBridge(client, {
      issueOpaqueId: opaqueSequence(),
      emptyCwd: EMPTY_CWD,
    });
    const binding = await bridge.verifyBinding(candidate(), "D:\\Project\\Fixture");
    const session = await bridge.createSession(binding, "D:\\Project\\Fixture", "docs/design.md");
    const { answer, candidate: issuedCandidate } = await askIssuedAnswer(bridge, client, session.id);
    const review = auditReview(answer);
    client.nextEvents.push([
      { type: "started", turnId: "audit_turn_secret" },
      { type: "text_delta", text: JSON.stringify(review) },
      {
        type: "completed",
        turn: { id: "audit_turn_secret", status: "completed", items: [], startedAt: 1, completedAt: 2 },
      },
    ]);

    await expect(
      bridge.auditEvidence({
        sessionId: session.id,
        candidate: issuedCandidate,
        answer,
        workspaceSnapshot: WORKSPACE_SNAPSHOT,
      }),
    ).resolves.toEqual({
      status: "completed",
      output: {
        reviewStatus: "evidence_reviewed",
        supportReview: review,
        unsupportedClaimIds: [],
      },
    });
    expect(client.forkCalls).toHaveLength(1);
    expect(client.projectCalls).toEqual([{
      emptyCwd: EMPTY_CWD,
      developerInstructions: SERVER_OWNED_MODEL_POLICY,
    }]);
    expect(client.turnCalls[1]!.threadId).toBe("project_side_secret");
    const envelope = JSON.parse(client.turnCalls[1]!.text) as {
      operation: string;
      payload: Record<string, unknown>;
    };
    expect(envelope.operation).toBe("evidence_audit");
    expect(envelope.payload).toHaveProperty("claims");
    expect(envelope.payload).toHaveProperty("untrustedEvidence");
    expect(envelope.payload).not.toHaveProperty("conclusionClaimId");
  });

  it("rejects a copied or hand-built answer before starting an audit turn", async () => {
    const client = new FakeBridgeClient();
    const bridge = new ContextBridge(client, {
      issueOpaqueId: opaqueSequence(),
      emptyCwd: EMPTY_CWD,
    });
    const binding = await bridge.verifyBinding(candidate(), "D:\\Project\\Fixture");
    const session = await bridge.createSession(binding, "D:\\Project\\Fixture", "docs/design.md");
    const { answer, candidate: issuedCandidate } = await askIssuedAnswer(bridge, client, session.id);
    const copied = JSON.parse(JSON.stringify(answer)) as EvidenceAnswer;

    await expect(bridge.auditEvidence({
      sessionId: session.id,
      candidate: issuedCandidate,
      answer: copied,
      workspaceSnapshot: WORKSPACE_SNAPSHOT,
    })).resolves.toEqual({
      status: "failed",
      code: "QUESTION_PACKET_INVALID",
    });
    expect(client.projectCalls).toHaveLength(0);
    expect(client.turnCalls).toHaveLength(1);
  });

  it("rejects a validated answer whose exact candidate was never issued by ask", async () => {
    const client = new FakeBridgeClient();
    const bridge = new ContextBridge(client, {
      issueOpaqueId: opaqueSequence(),
      emptyCwd: EMPTY_CWD,
    });
    const binding = await bridge.verifyBinding(candidate(), "D:\\Project\\Fixture");
    const session = await bridge.createSession(binding, "D:\\Project\\Fixture", "docs/design.md");
    const handBuiltCandidate = auditableCandidate();
    const answer = await citationValidatedAnswer(handBuiltCandidate);

    await expect(bridge.auditEvidence({
      sessionId: session.id,
      candidate: handBuiltCandidate,
      answer,
      workspaceSnapshot: WORKSPACE_SNAPSHOT,
    })).resolves.toEqual({ status: "failed", code: "QUESTION_PACKET_INVALID" });
    expect(client.projectCalls).toHaveLength(0);
    expect(client.turnCalls).toHaveLength(0);
  });

  it("rejects an audit thread id that reuses the generator side thread", async () => {
    const client = new FakeBridgeClient();
    client.project = appThread({
      id: "side_secret",
      cwd: EMPTY_CWD,
      ephemeral: true,
      forkedFromId: null,
      status: { type: "idle" },
      turns: [],
    });
    const bridge = new ContextBridge(client, {
      issueOpaqueId: opaqueSequence(),
      emptyCwd: EMPTY_CWD,
    });
    const binding = await bridge.verifyBinding(candidate(), "D:\\Project\\Fixture");
    const session = await bridge.createSession(binding, "D:\\Project\\Fixture", "docs/design.md");
    const { answer, candidate: issuedCandidate } = await askIssuedAnswer(bridge, client, session.id);

    await expect(bridge.auditEvidence({
      sessionId: session.id,
      candidate: issuedCandidate,
      answer,
      workspaceSnapshot: WORKSPACE_SNAPSHOT,
    })).resolves.toEqual({
      status: "failed",
      code: "MODEL_ISOLATION_UNPROVEN",
    });
    expect(client.turnCalls).toHaveLength(1);
  });

  it("remembers an audit thread id even when that thread fails shape validation", async () => {
    const client = new FakeBridgeClient();
    client.project = appThread({
      id: "invalid_audit_secret",
      cwd: EMPTY_CWD,
      ephemeral: true,
      forkedFromId: null,
      status: { type: "active" },
      turns: [],
    });
    const bridge = new ContextBridge(client, {
      issueOpaqueId: opaqueSequence(),
      emptyCwd: EMPTY_CWD,
    });
    const binding = await bridge.verifyBinding(candidate(), "D:\\Project\\Fixture");
    const session = await bridge.createSession(binding, "D:\\Project\\Fixture", "docs/design.md");
    const { answer, candidate: issuedCandidate } = await askIssuedAnswer(bridge, client, session.id);
    const request = {
      sessionId: session.id,
      candidate: issuedCandidate,
      answer,
      workspaceSnapshot: WORKSPACE_SNAPSHOT,
    };

    await expect(bridge.auditEvidence(request)).resolves.toEqual({
      status: "failed",
      code: "MODEL_ISOLATION_UNPROVEN",
    });
    client.project = appThread({
      id: "invalid_audit_secret",
      cwd: EMPTY_CWD,
      ephemeral: true,
      forkedFromId: null,
      status: { type: "idle" },
      turns: [],
    });
    client.nextEvents.push([
      { type: "started", turnId: "audit_turn_after_invalid" },
      { type: "text_delta", text: JSON.stringify(auditReview(answer)) },
      {
        type: "completed",
        turn: {
          id: "audit_turn_after_invalid",
          status: "completed",
          items: [],
          startedAt: 1,
          completedAt: 2,
        },
      },
    ]);
    await expect(bridge.auditEvidence(request)).resolves.toEqual({
      status: "failed",
      code: "MODEL_ISOLATION_UNPROVEN",
    });
    expect(client.turnCalls).toHaveLength(1);
  });

  it.each(["turn", "item"] as const)(
    "rejects a later audit that reuses an earlier audit %s id",
    async (reusedKind) => {
      const client = new FakeBridgeClient();
      const bridge = new ContextBridge(client, {
        issueOpaqueId: opaqueSequence(),
        emptyCwd: EMPTY_CWD,
      });
      const binding = await bridge.verifyBinding(candidate(), "D:\\Project\\Fixture");
      const session = await bridge.createSession(binding, "D:\\Project\\Fixture", "docs/design.md");
      await issueReviewedAnnotation(bridge, client, session.id);

      client.project = appThread({
        id: "project_side_fresh",
        cwd: EMPTY_CWD,
        ephemeral: true,
        forkedFromId: null,
        status: { type: "idle" },
        turns: [],
      });
      const { answer, candidate: issuedCandidate } = await askIssuedAnswer(
        bridge,
        client,
        session.id,
      );
      const turnId = reusedKind === "turn" ? "audit_turn_secret" : "audit_turn_fresh";
      client.nextEvents.push([
        { type: "started", turnId },
        { type: "text_delta", text: JSON.stringify(auditReview(answer)) },
        {
          type: "completed",
          turn: {
            id: turnId,
            status: "completed",
            items: reusedKind === "item"
              ? [{ type: "agentMessage", id: "audit_item_secret" }]
              : [],
            startedAt: 1,
            completedAt: 2,
          },
        },
      ]);

      await expect(bridge.auditEvidence({
        sessionId: session.id,
        candidate: issuedCandidate,
        answer,
        workspaceSnapshot: WORKSPACE_SNAPSHOT,
      })).resolves.toEqual({ status: "failed", code: "MODEL_ISOLATION_UNPROVEN" });
    },
  );

  it("rejects a generation turn id previously observed by the audit thread", async () => {
    const client = new FakeBridgeClient();
    const bridge = new ContextBridge(client, {
      issueOpaqueId: opaqueSequence(),
      emptyCwd: EMPTY_CWD,
    });
    const binding = await bridge.verifyBinding(candidate(), "D:\\Project\\Fixture");
    const session = await bridge.createSession(binding, "D:\\Project\\Fixture", "docs/design.md");
    await issueReviewedAnnotation(bridge, client, session.id);
    client.nextEvents.push([
      { type: "started", turnId: "audit_turn_secret" },
      { type: "text_delta", text: JSON.stringify({ kind: "answer", answer: auditableCandidate() }) },
      {
        type: "completed",
        turn: {
          id: "audit_turn_secret",
          status: "completed",
          items: [],
          startedAt: 1,
          completedAt: 2,
        },
      },
    ]);

    await expect(collect(bridge.ask(session.id, anchoredQuestion("reused audit id"))))
      .resolves.toEqual([
        { type: "failed", code: "MODEL_ISOLATION_UNPROVEN" },
      ]);
    expect(client.interruptCalls).toContainEqual({
      threadId: "side_secret",
      turnId: "audit_turn_secret",
    });
  });

  it("runs synthesis on the existing side thread with only accepted annotations", async () => {
    const client = new FakeBridgeClient();
    const bridge = new ContextBridge(client, {
      issueOpaqueId: opaqueSequence(),
      emptyCwd: EMPTY_CWD,
    });
    const binding = await bridge.verifyBinding(candidate(), "D:\\Project\\Fixture");
    const session = await bridge.createSession(binding, "D:\\Project\\Fixture", "docs/design.md");
    const { annotation, anchor } = await issueReviewedAnnotation(
      bridge,
      client,
      session.id,
    );
    const batch = {
      intents: [{
        annotationId: "annotation-1",
        operation: "insert_after" as const,
        targetAnchor: anchor,
        markdown: "\n\n> The gateway is exported from `src/gateway.ts`.",
        rationale: "Add the accepted explanation next to its source text.",
        evidenceIds: ["evidence-1"],
      }],
      conflicts: [],
    };
    client.nextEvents.push([
      { type: "started", turnId: "synthesis_turn_secret" },
      { type: "text_delta", text: JSON.stringify(batch) },
      {
        type: "completed",
        turn: { id: "synthesis_turn_secret", status: "completed", items: [], startedAt: 1, completedAt: 2 },
      },
    ]);

    await expect(bridge.synthesize(session.id, {
      documentPath: "docs/design.md",
      documentHash: DOCUMENT_HASH,
      snapshotDigest: SNAPSHOT_DIGEST,
      workspaceSnapshot: WORKSPACE_SNAPSHOT,
      annotations: [annotation],
    })).resolves.toEqual({ status: "completed", output: batch });
    expect(client.turnCalls).toHaveLength(3);
    expect(client.turnCalls[2]!.threadId).toBe("side_secret");
    const envelope = JSON.parse(client.turnCalls[2]!.text) as {
      operation: string;
      payload: Record<string, unknown>;
    };
    expect(envelope.operation).toBe("synthesis");
    expect(envelope.payload).toMatchObject({
      documentPath: "docs/design.md",
      documentHash: DOCUMENT_HASH,
      snapshotDigest: SNAPSHOT_DIGEST,
    });
  });

  it("does not overlap synthesis with a question on the same session side thread", async () => {
    const client = new FakeBridgeClient();
    const bridge = new ContextBridge(client, {
      issueOpaqueId: opaqueSequence(),
      emptyCwd: EMPTY_CWD,
    });
    const binding = await bridge.verifyBinding(candidate(), "D:\\Project\\Fixture");
    const session = await bridge.createSession(binding, "D:\\Project\\Fixture", "docs/design.md");
    const { annotation } = await issueReviewedAnnotation(bridge, client, session.id);
    const askEntered = new Promise<void>((resolve) => {
      client.enterTurnResolvers[2] = resolve;
    });
    const synthesisEntered = new Promise<void>((resolve) => {
      client.enterTurnResolvers[3] = resolve;
    });
    client.blockingTurnReleases[2] = new Promise<void>((resolve) => {
      client.releaseTurnResolvers[2] = resolve;
    });
    client.blockingTurnReleases[3] = new Promise<void>((resolve) => {
      client.releaseTurnResolvers[3] = resolve;
    });

    const question = collect(bridge.ask(session.id, anchoredQuestion("question before synthesis")));
    await askEntered;
    const synthesis = bridge.synthesize(session.id, {
      documentPath: "docs/design.md",
      documentHash: DOCUMENT_HASH,
      snapshotDigest: SNAPSHOT_DIGEST,
      workspaceSnapshot: WORKSPACE_SNAPSHOT,
      annotations: [annotation],
    });
    const synthesisState = await Promise.race([
      synthesisEntered.then(() => "entered" as const),
      new Promise<"pending">((resolve) => setImmediate(() => resolve("pending"))),
    ]);

    expect(synthesisState).toBe("pending");
    client.releaseTurnResolvers[2]!();
    await synthesisEntered;
    client.releaseTurnResolvers[3]!();
    await Promise.all([question, synthesis]);
  });

  it("rejects accessor-shaped synthesis input without invoking getters", async () => {
    const client = new FakeBridgeClient();
    const bridge = new ContextBridge(client, {
      issueOpaqueId: opaqueSequence(),
      emptyCwd: EMPTY_CWD,
    });
    const binding = await bridge.verifyBinding(candidate(), "D:\\Project\\Fixture");
    const session = await bridge.createSession(binding, "D:\\Project\\Fixture", "docs/design.md");
    const { annotation } = await issueReviewedAnnotation(bridge, client, session.id);
    let reads = 0;
    const request = Object.defineProperties({}, {
      documentPath: { enumerable: true, value: "docs/design.md" },
      documentHash: { enumerable: true, value: DOCUMENT_HASH },
      workspaceSnapshot: { enumerable: true, value: WORKSPACE_SNAPSHOT },
      annotations: { enumerable: true, value: [annotation] },
      snapshotDigest: {
        enumerable: true,
        get() {
          reads += 1;
          return reads === 1 ? SNAPSHOT_DIGEST : "f".repeat(64);
        },
      },
    });

    await expect(bridge.synthesize(session.id, request as never)).resolves.toEqual({
      status: "failed",
      code: "QUESTION_PACKET_INVALID",
    });
    expect(reads).toBe(0);
    expect(client.turnCalls).toHaveLength(2);
  });

  it("rejects copied annotations and copied audit results before synthesis execution", async () => {
    const client = new FakeBridgeClient();
    const bridge = new ContextBridge(client, {
      issueOpaqueId: opaqueSequence(),
      emptyCwd: EMPTY_CWD,
    });
    const binding = await bridge.verifyBinding(candidate(), "D:\\Project\\Fixture");
    const session = await bridge.createSession(binding, "D:\\Project\\Fixture", "docs/design.md");
    const { annotation, auditResult, answer } = await issueReviewedAnnotation(
      bridge,
      client,
      session.id,
    );

    expect(() => bridge.issueAcceptedSynthesisAnnotation(session.id, {
      annotationId: "annotation-copy",
      disposition: "inline",
      answer,
      auditResult: JSON.parse(JSON.stringify(auditResult)),
    })).toThrow(new ContextBridgeError("ANNOTATION_AUTHORITY_INVALID"));
    await expect(bridge.synthesize(session.id, {
      documentPath: "docs/design.md",
      documentHash: DOCUMENT_HASH,
      snapshotDigest: SNAPSHOT_DIGEST,
      workspaceSnapshot: WORKSPACE_SNAPSHOT,
      annotations: [JSON.parse(JSON.stringify(annotation))],
    })).resolves.toEqual({ status: "failed", code: "QUESTION_PACKET_INVALID" });
    expect(client.turnCalls).toHaveLength(2);
  });

  it("does not let a caller move a reviewed answer to another anchor", async () => {
    const client = new FakeBridgeClient();
    const bridge = new ContextBridge(client, {
      issueOpaqueId: opaqueSequence(),
      emptyCwd: EMPTY_CWD,
    });
    const binding = await bridge.verifyBinding(candidate(), "D:\\Project\\Fixture");
    const session = await bridge.createSession(binding, "D:\\Project\\Fixture", "docs/design.md");
    const { auditResult, answer, anchor: originalAnchor } = await issueReviewedAnnotation(
      bridge,
      client,
      session.id,
    );

    const movedRequest = {
      annotationId: "annotation-moved",
      disposition: "inline",
      anchor: { ...originalAnchor, startOffset: 21, endOffset: 28 },
      answer,
      auditResult,
    };
    expect(() => bridge.issueAcceptedSynthesisAnnotation(
      session.id,
      movedRequest as never,
    )).toThrow(new ContextBridgeError("ANNOTATION_AUTHORITY_INVALID"));
  });

  it("rejects accessor-shaped annotation requests without invoking getters", async () => {
    const client = new FakeBridgeClient();
    const unauditedAnswer = await citationValidatedAnswer();
    const bridge = new ContextBridge(client, {
      issueOpaqueId: opaqueSequence(),
      emptyCwd: EMPTY_CWD,
    });
    const binding = await bridge.verifyBinding(candidate(), "D:\\Project\\Fixture");
    const session = await bridge.createSession(binding, "D:\\Project\\Fixture", "docs/design.md");
    const { auditResult, answer: reviewedAnswer } = await issueReviewedAnnotation(
      bridge,
      client,
      session.id,
    );
    let answerReads = 0;
    const request = Object.defineProperties({}, {
      annotationId: { enumerable: true, value: "annotation-accessor" },
      disposition: { enumerable: true, value: "inline" },
      auditResult: { enumerable: true, value: auditResult },
      answer: {
        enumerable: true,
        get() {
          answerReads += 1;
          return answerReads === 1 ? reviewedAnswer : unauditedAnswer;
        },
      },
    });

    expect(() => bridge.issueAcceptedSynthesisAnnotation(
      session.id,
      request as never,
    )).toThrow(new ContextBridgeError("ANNOTATION_AUTHORITY_INVALID"));
    expect(answerReads).toBe(0);
  });

  it("rejects synthesis output that omits or changes annotation authority", async () => {
    const client = new FakeBridgeClient();
    const bridge = new ContextBridge(client, {
      issueOpaqueId: opaqueSequence(),
      emptyCwd: EMPTY_CWD,
    });
    const binding = await bridge.verifyBinding(candidate(), "D:\\Project\\Fixture");
    const session = await bridge.createSession(binding, "D:\\Project\\Fixture", "docs/design.md");
    const { annotation, anchor } = await issueReviewedAnnotation(
      bridge,
      client,
      session.id,
    );
    const invalidBatches = [
      { intents: [], conflicts: [{ annotationId: "annotation-invented", reason: "No match." }] },
      {
        intents: [{
          annotationId: "annotation-1",
          operation: "insert_after",
          targetAnchor: anchor,
          markdown: "\n\n> Explanation.",
          rationale: "Explain.",
          evidenceIds: ["evidence-invented"],
        }],
        conflicts: [],
      },
      {
        intents: [{
          annotationId: "annotation-1",
          operation: "insert_after",
          targetAnchor: { ...anchor, selectedText: "different" },
          markdown: "\n\n> Explanation.",
          rationale: "Explain.",
          evidenceIds: ["evidence-1"],
        }],
        conflicts: [],
      },
    ];
    for (const [index, invalidBatch] of invalidBatches.entries()) {
      client.nextEvents.push([
        { type: "started", turnId: `synthesis_invalid_${index}` },
        { type: "text_delta", text: JSON.stringify(invalidBatch) },
        {
          type: "completed",
          turn: {
            id: `synthesis_invalid_${index}`,
            status: "completed",
            items: [],
            startedAt: 1,
            completedAt: 2,
          },
        },
      ]);
      await expect(bridge.synthesize(session.id, {
        documentPath: "docs/design.md",
        documentHash: DOCUMENT_HASH,
        snapshotDigest: SNAPSHOT_DIGEST,
        workspaceSnapshot: WORKSPACE_SNAPSHOT,
        annotations: [annotation],
      })).resolves.toEqual({ status: "failed", code: "MODEL_OUTPUT_INVALID" });
    }
  });

  it("maps an abort before turn correlation to cancelled without exposing the rejection", async () => {
    const client = new FakeBridgeClient();
    client.turnFailure = new Error("turn_secret C:\\Users\\private abort");
    const bridge = new ContextBridge(client, {
      issueOpaqueId: opaqueSequence(),
      emptyCwd: EMPTY_CWD,
    });
    const binding = await bridge.verifyBinding(candidate(), "D:\\Project\\Fixture");
    const session = await bridge.createSession(binding, "D:\\Project\\Fixture", "docs/design.md");
    const controller = new AbortController();
    controller.abort();
    await expect(
      collect(bridge.ask(session.id, anchoredQuestion("cancel"), controller.signal)),
    ).resolves.toEqual([{ type: "cancelled" }]);
  });
});
