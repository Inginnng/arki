import { describe, expect, it } from "vitest";

import {
  EvidenceAnswerSchema,
  QuestionRunPageSchema,
  type ModelAnswerCandidate,
} from "@aimd/contracts";
import {
  createApprovalAuthority,
  createWorkspaceSnapshot,
  sha256Text,
  type ApprovalAuthority,
  type EvidencePacket,
} from "@aimd/reader-core";
import type { BridgeOperationResult } from "@aimd/app-server-bridge";

import { MemoryAnnotationRepository } from "./store.js";
import {
  InMemoryQuestionRunStore,
  ReaderService,
  ReaderServiceError,
  type ReaderServiceBridge,
  type ReaderServiceWriter,
  type ReaderServiceWorkspace,
} from "./service.js";

const SOURCE = "# Guide\n\nWork enters here.\n";

class FixtureWorkspace implements ReaderServiceWorkspace {
  readonly files = new Map<string, string>([
    ["README.md", SOURCE],
    ["src/gateway.ts", "export function enter() { return ''ok''; }\n"],
    ["src/helper.ts", "export const helper = true;\n"],
  ]);
  denySearch = false;
  expansion = false;
  failSearchAt: number | undefined;
  failSearchQuery: string | undefined;
  readonly searchQueries: string[] = [];

  async readDocument(path: string) {
    const text = this.require(path);
    return {
      path,
      hash: sha256Text(text),
      lines: text.split(/\n/u).slice(0, -1).map((line, index) => ({ number: index + 1, text: line })),
      headings: [{ depth: 1, text: "Guide", line: 1 }],
      anchorStatus: { status: "available" as const },
    };
  }

  async readDocumentSource(path: string) {
    const source = this.require(path);
    return { path, source, hash: sha256Text(source) };
  }

  async readFile(path: string, range: { startLine?: number; endLine?: number } = {}) {
    const text = this.require(path);
    const all = text.split(/\n/u).slice(0, -1);
    const startLine = range.startLine ?? 1;
    const endLine = range.endLine ?? all.length;
    const lines = all.slice(startLine - 1, endLine).map((value, index) => ({
      line: startLine + index,
      text: value,
    }));
    return {
      path,
      startLine,
      endLine,
      totalLines: all.length,
      lines,
      excerpt: lines.map(({ line, text: value }) => `${line}: ${value}`).join("\n"),
      fileHash: sha256Text(text),
      truncated: false,
    };
  }

  async readLines(path: string, startLine: number, endLine: number) {
    return this.readFile(path, { startLine, endLine });
  }

  async readEvidenceRange(path: string, startLine: number, endLine: number) {
    const text = this.require(path);
    const all = text.split(/\n/u).slice(0, -1);
    const excerpt = all.slice(startLine - 1, endLine).join("\n");
    return {
      path,
      startLine,
      endLine,
      totalLines: all.length,
      excerpt,
      fileHash: sha256Text(text),
      byteLength: Buffer.byteLength(excerpt),
      sourceLocationKey: `fixture:${path}`,
    };
  }

  async searchProject(query: string) {
    this.searchQueries.push(query);
    if (this.failSearchAt === this.searchQueries.length || this.failSearchQuery === query) {
      throw Object.assign(new Error("denied"), { code: "PATH_ACCESS_DENIED" });
    }
    if (this.denySearch) throw Object.assign(new Error("denied"), { code: "PATH_ACCESS_DENIED" });
    const path = this.expansion || query.includes("helper") ? "src/helper.ts" : "src/gateway.ts";
    const text = this.require(path).trimEnd();
    return {
      query,
      matches: [{ path, line: 1, column: 1, startLine: 1, endLine: 1, excerpt: text, fileHash: sha256Text(this.require(path)) }],
      inspectedPaths: [path],
      truncated: false,
    };
  }

  async snapshot(request: { relevantPaths?: readonly string[] } = {}) {
    const relevantPaths = [...new Set(request.relevantPaths ?? [])].sort();
    const state = JSON.stringify([...this.files.entries()].sort());
    return createWorkspaceSnapshot({
      projectRoot: "C:\\fixture-project",
      rootId: "root-fixture",
      branch: null,
      head: null,
      createdAt: "2026-09-01T00:00:00.000Z",
      gitState: { kind: "dirty", status: "fixture", contentDigest: sha256Text(state) },
      relevantFileHashes: relevantPaths.map((path) => ({ path, hash: sha256Text(this.require(path)) })),
    });
  }

  async prepareSafeOutputSource(path: string) {
    return {
      canonicalRoot: "C:\\fixture-project",
      canonicalSourcePath: `C:\\fixture-project\\${path.replaceAll("/", "\\")}`,
      sourceContentSha256: sha256Text(this.require(path)),
    };
  }

  private require(path: string): string {
    const text = this.files.get(path);
    if (text === undefined) throw Object.assign(new Error("missing"), { code: "PATH_NOT_FOUND" });
    return text;
  }
}

class FixtureBridge implements ReaderServiceBridge {
  mode: "supported" | "unsupported" | "audit_unavailable" | "audit_stale" | "cancel" | "stale" | "expand" | "expand_forever" = "supported";
  synthesizeMutation: "none" | "source" | "evidence" = "none";
  asks: Array<{ generation: string; packets: readonly EvidencePacket[] }> = [];
  private expansionCount = 0;

  constructor(private readonly workspace: FixtureWorkspace) {}

  async verifyBinding(binding: { status: string }) {
    return binding.status === "candidate"
      ? { status: "verified" as const, bindingId: "binding-1", cutoffLabel: "Through the latest completed parent turn" as const }
      : { status: "unavailable" as const, code: "TASK_CONTEXT_UNAVAILABLE" as const };
  }

  async createSession(binding: { status: string }, _root: string, documentPath: string) {
    return {
      id: "session-fixture",
      bindingStatus: binding.status === "verified" ? "verified" as const : "unavailable" as const,
      contextMode: binding.status === "verified" ? "task_and_project" as const : "project_only" as const,
      rootId: "root-fixture",
      workspaceLabel: "fixture-project",
      documentPath,
      ...(binding.status === "verified" ? { cutoffLabel: "Through the latest completed parent turn" } : { degradationReason: "Task context unavailable; project evidence only" }),
    };
  }

  async *ask(_sessionId: string, question: Parameters<ReaderServiceBridge["ask"]>[1], signal?: AbortSignal) {
    this.asks.push({ generation: question.generation, packets: question.evidencePackets });
    yield { type: "progress" as const, phase: "started" as const };
    if (this.mode === "cancel") {
      await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
      yield { type: "cancelled" as const };
      return;
    }
    if (this.mode === "stale") {
      this.workspace.files.set("src/gateway.ts", "export const dirty = true;\n");
    }
    if ((this.mode === "expand" && this.expansionCount++ === 0) || this.mode === "expand_forever") {
      this.workspace.expansion = true;
      yield {
        type: "completed" as const,
        output: { kind: "evidence_request" as const, request: { query: "helper", reason: "Need helper definition", requestedKinds: ["code_excerpt" as const] } },
      };
      return;
    }
    const evidence = question.evidencePackets.flatMap((packet) => packet.evidence);
    const selected = evidence.find((item) => item.path.startsWith("src/")) ?? evidence[0]!;
    const category = question.evidencePackets.flatMap((packet) => packet.evidence).every((item) => item.path === "README.md")
      ? "document_literal" as const
      : "architecture" as const;
    const answer: ModelAnswerCandidate = {
      conclusionClaimId: "claim-1",
      claims: [{
        id: "claim-1",
        statement: "Work enters through the cited implementation.",
        category,
        evidenceIds: category === "architecture"
          ? [...new Map(evidence.map((item) => [item.path, item])).values()].slice(0, 2).map(({ id }) => id)
          : [selected.id],
      }],
      unknowns: [],
    };
    yield { type: "completed" as const, output: { kind: "answer" as const, answer } };
  }

  async auditEvidence(input: Parameters<ReaderServiceBridge["auditEvidence"]>[0]) {
    if (this.mode === "audit_unavailable") {
      return { status: "failed" as const, code: "MODEL_ISOLATION_UNPROVEN" as const };
    }
    if (this.mode === "audit_stale") {
      this.workspace.files.set("src/gateway.ts", "export const changedDuringAudit = true;\n");
    }
    const unsupported = this.mode === "unsupported";
    return {
      status: "completed" as const,
      output: {
        reviewStatus: unsupported ? "unsupported" as const : "evidence_reviewed" as const,
        supportReview: {
          id: "review-1",
          reviewer: "independent_model" as const,
          modelAssisted: true as const,
          runId: input.answer.runId,
          generation: input.answer.generation,
          candidateDigest: input.answer.candidateDigest,
          snapshotDigest: input.answer.snapshotDigest,
          records: input.answer.claims.map((claim) => ({
            id: `review-${claim.id}`,
            claimId: claim.id,
            evidenceIds: claim.evidenceIds,
            verdict: unsupported ? "unsupported" as const : "directly_supported" as const,
            rationale: unsupported ? "The excerpt is unrelated." : "The excerpt directly supports the claim.",
          })),
        },
        unsupportedClaimIds: unsupported ? input.answer.claims.map(({ id }) => id) : [],
      },
    };
  }

  issueAcceptedSynthesisAnnotation(_sessionId: string, input: Parameters<ReaderServiceBridge["issueAcceptedSynthesisAnnotation"]>[1]) {
    return {
      annotationId: input.annotationId,
      disposition: input.disposition,
      anchor: { documentPath: input.answer.documentPath!, documentHash: sha256Text(SOURCE), headingPath: ["Guide"], selectedText: "Work enters here.", prefix: "# Guide\n\n", suffix: "\n", startOffset: 9, endOffset: 26 },
      claims: input.answer.claims,
      evidence: input.answer.evidence,
    };
  }

  async synthesize(
    _sessionId: string,
    input: Parameters<ReaderServiceBridge["synthesize"]>[1],
  ): Promise<BridgeOperationResult<unknown>> {
    if (this.synthesizeMutation === "source") {
      this.workspace.files.set("README.md", `${SOURCE}\nChanged during synthesis.\n`);
    } else if (this.synthesizeMutation === "evidence") {
      this.workspace.files.set("src/gateway.ts", "export const changedDuringSynthesis = true;\n");
    }
    return {
      status: "completed" as const,
      output: {
        intents: input.annotations.map((annotation) => ({
          annotationId: annotation.annotationId,
          operation: "insert_after" as const,
          targetAnchor: annotation.anchor,
          markdown: "\n\n> Explanation.",
          rationale: "Preserve the accepted explanation.",
          evidenceIds: [annotation.evidence[0]!.id],
        })),
        conflicts: [],
      },
    };
  }
}

function makeService(
  bindingStatus: "verified" | "unavailable" = "verified",
  options: {
    approvalAuthority?: ApprovalAuthority;
    writer?: ReaderServiceWriter;
    runCapacity?: number;
  } = {},
) {
  const workspace = new FixtureWorkspace();
  const bridge = new FixtureBridge(workspace);
  const repository = new MemoryAnnotationRepository({ now: () => new Date("2026-09-01T00:00:00.000Z") });
  let id = 0;
  let tokenSeed = 0;
  const writes: string[] = [];
  const service = new ReaderService({
    roots: [{
      rootId: "root-fixture",
      workspaceLabel: "fixture-project",
      canonicalRoot: "C:\\fixture-project",
      workspace,
      listDocuments: async () => [{ path: "README.md", title: "Guide", hash: sha256Text(SOURCE) }],
    }],
    repository,
    bridge,
    approvalAuthority: options.approvalAuthority ?? createApprovalAuthority({ randomBytes: () => new Uint8Array(32).fill(++tokenSeed) }),
    writer: options.writer ?? {
      capability: async () => ({ status: "available" as const, capability: "windows_locked_chain_create_new_v1" as const }),
      createExplainedSibling: async (_source, targetBasename, content) => {
        if (workspace.files.has("README.explained.md")) throw Object.assign(new Error("exists"), { code: "OUTPUT_ALREADY_EXISTS" });
        const text = Buffer.from(content).toString("utf8");
        workspace.files.set("README.explained.md", text);
        writes.push(targetBasename);
        return { targetBasename, byteLength: content.byteLength };
      },
    },
    captureTaskBinding: () => bindingStatus === "verified"
      ? { status: "candidate", parentThreadId: "parent-thread", source: "codex-hidden-meta" }
      : { status: "unavailable" },
    issueId: (scope) => `${scope}-${++id}`,
    now: () => new Date("2026-09-01T00:00:00.000Z"),
    ...(options.runCapacity === undefined ? {} : { runCapacity: options.runCapacity }),
  });
  return { service, workspace, bridge, repository, writes };
}

async function waitTerminal(service: ReaderService, runId: string) {
  for (let index = 0; index < 50; index += 1) {
    const page = await service.pollQuestion(runId);
    const terminal = page.outcome === "events" ? page.events.find((event) => ["completed", "stale", "failed", "cancelled"].includes(event.type)) : undefined;
    if (terminal) return terminal;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("run did not finish");
}

describe("ReaderService", () => {
  it("preserves a UTF-8 BOM when the exact-source guard fallback is used", async () => {
    const { service, workspace } = makeService();
    const source = `\uFEFF${SOURCE}`;
    workspace.files.set("README.md", source);
    Object.defineProperty(workspace, "readDocumentSource", { value: undefined });
    Object.defineProperty(workspace, "guard", {
      value: {
        readFileBytes: async () => ({
          bytes: Buffer.from(source, "utf8"),
          canonicalRelativePath: "README.md",
        }),
      },
    });

    await expect(service.openDocument("root-fixture", "README.md"))
      .resolves.toMatchObject({ markdown: source, hash: sha256Text(source) });
  });

  it("returns strict redacted root/document/source DTOs and captures binding metadata synchronously", async () => {
    const { service } = makeService();
    expect(await service.listRoots()).toEqual([{ rootId: "root-fixture", workspaceLabel: "fixture-project" }]);
    expect((await service.openDocument("root-fixture", "README.md"))).not.toHaveProperty("canonicalRoot");
    expect((await service.readSource("root-fixture", "README.md", 1, 2))).not.toHaveProperty("sourceLocationKey");
    const session = await service.createSession("root-fixture", "README.md", { hidden: "host-only" });
    expect(session.contextMode).toBe("task_and_project");
    expect(session).not.toHaveProperty("parentThreadId");
  });

  it("fails closed when an observed MCP root is not authorized and hides project-only roots without roots/list", async () => {
    const base = makeService();
    const guarded = new ReaderService({
      ...base.service.dependencies,
      roots: [{
        rootId: "root-fixture",
        workspaceLabel: "fixture-project",
        canonicalRoot: "C:\\fixture-project",
        workspace: base.workspace,
        listDocuments: async () => [],
        requiresMcpRoot: true,
        authorizeMcpRoots: (roots) => roots.some(({ uri }) => uri === "file:///C:/fixture-project"),
      }],
    });
    expect(await guarded.listRoots()).toEqual([]);
    expect(await guarded.listRoots([{ uri: "file:///C:/wrong-project" }])).toEqual([]);
    expect(await guarded.listRoots([{ uri: "file:///C:/fixture-project" }])).toEqual([{ rootId: "root-fixture", workspaceLabel: "fixture-project" }]);
  });

  it("revokes every session-owned capability when the authorized MCP root disappears", async () => {
    const base = makeService();
    let authorized = true;
    const guarded = new ReaderService({
      ...base.service.dependencies,
      roots: [{
        rootId: "root-fixture",
        workspaceLabel: "fixture-project",
        canonicalRoot: "C:\\fixture-project",
        workspace: base.workspace,
        listDocuments: async () => [{ path: "README.md", title: "Guide", hash: sha256Text(SOURCE) }],
        requiresMcpRoot: true,
        authorizeMcpRoots: () => authorized,
      }],
    });
    const observedRoots = [{ uri: "file:///C:/fixture-project" }];
    const session = await guarded.createSession("root-fixture", "README.md", {});
    const { runId } = await guarded.startQuestion(session.id, {
      question: "How does work enter?",
      startOffset: 9,
      endOffset: 26,
    });
    expect((await waitTerminal(guarded, runId)).type).toBe("completed");
    await guarded.setDisposition(runId, "inline");
    const preview = await guarded.preparePatch(session.id, [runId]);

    await expect(guarded.authorizeAccess({ kind: "session", id: session.id }, observedRoots)).resolves.toBeUndefined();
    await expect(guarded.authorizeAccess({ kind: "run", id: runId }, observedRoots)).resolves.toBeUndefined();
    await expect(guarded.authorizeAccess({ kind: "annotation", id: runId }, observedRoots)).resolves.toBeUndefined();
    await expect(guarded.authorizeAccess({ kind: "preview", id: preview.id }, observedRoots)).resolves.toBeUndefined();

    authorized = false;
    for (const reference of [
      { kind: "session" as const, id: session.id },
      { kind: "run" as const, id: runId },
      { kind: "annotation" as const, id: runId },
      { kind: "preview" as const, id: preview.id },
    ]) {
      await expect(guarded.authorizeAccess(reference, observedRoots)).rejects.toMatchObject({
        code: "ROOT_AUTHORIZATION_REVOKED",
      });
    }
  });

  it("persists only a structurally validated and independently supported answer", async () => {
    const { service, repository } = makeService();
    const session = await service.createSession("root-fixture", "README.md", {});
    const { runId } = await service.startQuestion(session.id, { question: "How does work enter?", startOffset: 9, endOffset: 26 });
    const terminal = await waitTerminal(service, runId);
    expect(terminal.type).toBe("completed");
    if (terminal.type !== "completed") throw new Error("expected completion");
    expect(EvidenceAnswerSchema.parse(terminal.payload.answer).reviewStatus).toBe("evidence_reviewed");
    expect(await repository.getAnnotation(runId)).toBeDefined();
  });

  it("does not persist an answer that the independent audit marks unsupported", async () => {
    const { service, bridge, repository } = makeService();
    bridge.mode = "unsupported";
    const session = await service.createSession("root-fixture", "README.md", {});
    const { runId } = await service.startQuestion(session.id, { question: "How does work enter?", startOffset: 9, endOffset: 26 });
    const terminal = await waitTerminal(service, runId);
    expect(terminal.type).toBe("completed");
    if (terminal.type !== "completed") throw new Error("expected completion");
    expect(terminal.payload.answer.reviewStatus).toBe("unsupported");
    expect(await repository.getAnnotation(runId)).toBeUndefined();
  });

  it("returns citation-validated evidence when independent audit is unavailable without making it durable", async () => {
    const { service, bridge, repository } = makeService();
    bridge.mode = "audit_unavailable";
    const session = await service.createSession("root-fixture", "README.md", {});
    const { runId } = await service.startQuestion(session.id, {
      question: "How does work enter?",
      startOffset: 9,
      endOffset: 26,
    });
    const terminal = await waitTerminal(service, runId);
    expect(terminal.type).toBe("completed");
    if (terminal.type !== "completed") throw new Error("expected completion");
    expect(terminal.payload.answer.reviewStatus).toBe("citation_validated");
    expect(await repository.getAnnotation(runId)).toBeUndefined();
    expect(await repository.getDraft(runId)).toMatchObject({ status: "failed" });
  });

  it("marks the answer stale when cited workspace evidence changes during the run", async () => {
    const { service, bridge } = makeService();
    bridge.mode = "stale";
    const session = await service.createSession("root-fixture", "README.md", {});
    const { runId } = await service.startQuestion(session.id, { question: "How does work enter?", startOffset: 9, endOffset: 26 });
    const terminal = await waitTerminal(service, runId);
    expect(terminal.type).toBe("stale");
    if (terminal.type !== "stale") throw new Error("expected stale");
    expect(terminal.payload.answer?.reviewStatus).toBe("stale");
  });

  it("marks the answer stale when cited workspace evidence changes during independent audit", async () => {
    const { service, bridge, repository } = makeService();
    bridge.mode = "audit_stale";
    const session = await service.createSession("root-fixture", "README.md", {});
    const { runId } = await service.startQuestion(session.id, {
      question: "How does work enter?",
      startOffset: 9,
      endOffset: 26,
    });
    const terminal = await waitTerminal(service, runId);
    expect(terminal.type).toBe("stale");
    if (terminal.type !== "stale") throw new Error("expected stale");
    expect(terminal.payload.answer?.reviewStatus).toBe("stale");
    expect(await repository.getAnnotation(runId)).toBeUndefined();
  });

  it("keeps a cancelled draft and never persists partial answer text", async () => {
    const { service, bridge, repository } = makeService();
    bridge.mode = "cancel";
    const session = await service.createSession("root-fixture", "README.md", {});
    const { runId } = await service.startQuestion(session.id, { question: "How does work enter?", startOffset: 9, endOffset: 26 });
    await service.cancelQuestion(runId);
    expect((await waitTerminal(service, runId)).type).toBe("cancelled");
    expect(await repository.getAnnotation(runId)).toBeUndefined();
    expect(await repository.getDraft(runId)).toMatchObject({ question: "How does work enter?", status: "cancelled" });
  });

  it("treats cancellation of an already terminal run as idempotent", async () => {
    const { service } = makeService();
    const session = await service.createSession("root-fixture", "README.md", {});
    const { runId } = await service.startQuestion(session.id, { question: "How does work enter?", startOffset: 9, endOffset: 26 });
    expect((await waitTerminal(service, runId)).type).toBe("completed");
    await expect(service.cancelQuestion(runId)).resolves.toBeUndefined();
    await expect(service.cancelQuestion(runId)).resolves.toBeUndefined();
  });

  it("closes idempotently, cancels active work, retains its draft, and rejects new sessions/questions", async () => {
    const { service, bridge, repository } = makeService();
    bridge.mode = "cancel";
    const session = await service.createSession("root-fixture", "README.md", {});
    const { runId } = await service.startQuestion(session.id, { question: "How does work enter?", startOffset: 9, endOffset: 26 });
    await service.close();
    await service.close();
    expect((await waitTerminal(service, runId)).type).toBe("cancelled");
    expect(await repository.getDraft(runId)).toMatchObject({ status: "cancelled" });
    await expect(service.startQuestion(session.id, { question: "Again", startOffset: 9, endOffset: 26 })).rejects.toMatchObject({ code: "SERVICE_CLOSED" });
    await expect(service.createSession("root-fixture", "README.md", {})).rejects.toMatchObject({ code: "SERVICE_CLOSED" });
  });

  it("waits for an authorized write already in flight and rejects later mutation calls", async () => {
    let releaseWrite!: () => void;
    let markWriteStarted!: () => void;
    const writeStarted = new Promise<void>((resolve) => { markWriteStarted = resolve; });
    const writeReleased = new Promise<void>((resolve) => { releaseWrite = resolve; });
    const writer: ReaderServiceWriter = {
      capability: async () => ({ status: "available" as const, capability: "windows_locked_chain_create_new_v1" as const }),
      createExplainedSibling: async (_source, targetBasename, content) => {
        markWriteStarted();
        await writeReleased;
        return { targetBasename, byteLength: content.byteLength };
      },
    };
    const { service } = makeService("verified", { writer });
    const session = await service.createSession("root-fixture", "README.md", {});
    const { runId } = await service.startQuestion(session.id, {
      question: "How does work enter?",
      startOffset: 9,
      endOffset: 26,
    });
    expect((await waitTerminal(service, runId)).type).toBe("completed");
    await service.setDisposition(runId, "inline");
    const preview = await service.preparePatch(session.id, [runId]);
    const approval = await service.approvePatch(session.id, preview.sourceHash, preview.diffHash);

    const writing = service.writeExplained(session.id, preview.id, approval.approvalToken);
    await writeStarted;
    const closing = service.close();
    let closed = false;
    void closing.then(() => { closed = true; });
    await Promise.resolve();
    expect(closed).toBe(false);

    releaseWrite();
    await expect(writing).resolves.toEqual({ path: "README.explained.md" });
    await closing;
    await expect(service.setDisposition(runId, "ignore")).rejects.toMatchObject({ code: "SERVICE_CLOSED" });
    await expect(service.preparePatch(session.id, [runId])).rejects.toMatchObject({ code: "SERVICE_CLOSED" });
    await expect(service.approvePatch(session.id, preview.sourceHash, preview.diffHash)).rejects.toMatchObject({ code: "SERVICE_CLOSED" });
    await expect(service.writeExplained(session.id, preview.id, approval.approvalToken)).rejects.toMatchObject({ code: "SERVICE_CLOSED" });
  });

  it("waits for session persistence already in flight before close resolves", async () => {
    const { service, repository } = makeService();
    const originalUpsert = repository.upsertSession.bind(repository);
    let releasePersist!: () => void;
    let markPersistStarted!: () => void;
    const persistStarted = new Promise<void>((resolve) => { markPersistStarted = resolve; });
    const persistReleased = new Promise<void>((resolve) => { releasePersist = resolve; });
    repository.upsertSession = async (session) => {
      markPersistStarted();
      await persistReleased;
      return await originalUpsert(session);
    };

    const creating = service.createSession("root-fixture", "README.md", {});
    await persistStarted;
    const closing = service.close();
    let closed = false;
    void closing.then(() => { closed = true; });
    await Promise.resolve();
    expect(closed).toBe(false);

    releasePersist();
    await expect(creating).resolves.toMatchObject({ id: "session-fixture" });
    await closing;
    await expect(service.createSession("root-fixture", "README.md", {}))
      .rejects.toMatchObject({ code: "SERVICE_CLOSED" });
  });

  it("uses project-only mode without task binding and document-only mode after search denial", async () => {
    const projectOnly = makeService("unavailable");
    const projectSession = await projectOnly.service.createSession("root-fixture", "README.md", {});
    expect(projectSession.contextMode).toBe("project_only");
    const first = await projectOnly.service.startQuestion(projectSession.id, { question: "How does work enter?", startOffset: 9, endOffset: 26 });
    const projectTerminal = await waitTerminal(projectOnly.service, first.runId);
    if (projectTerminal.type !== "completed") throw new Error("expected completion");
    expect(projectTerminal.payload.answer.contextMode).toBe("project_only");
    expect(projectTerminal.payload.answer.evidence.every((item) => item.kind !== "task_decision")).toBe(true);

    const documentOnly = makeService();
    documentOnly.workspace.denySearch = true;
    const documentSession = await documentOnly.service.createSession("root-fixture", "README.md", {});
    const second = await documentOnly.service.startQuestion(documentSession.id, { question: "What does this sentence literally say?", startOffset: 9, endOffset: 26 });
    const documentTerminal = await waitTerminal(documentOnly.service, second.runId);
    if (documentTerminal.type !== "completed") throw new Error("expected completion");
    expect(documentTerminal.payload.answer.contextMode).toBe("document_only");
    expect(documentTerminal.payload.answer.claims.every((claim) => claim.category === "document_literal")).toBe(true);
  });

  it("adds bounded manifest, architecture-entry, config, and symbol-call searches for architecture questions", async () => {
    const { service, workspace, bridge } = makeService();
    workspace.files.set("package.json", "{\"scripts\":{\"start\":\"node src/index.js\"},\"dependencies\":{}}\n");
    workspace.files.set("src/index.ts", "export function main() { return Gateway(); }\n");
    workspace.files.set("src/config.ts", "export const config = { transport: 'stdio' };\n");
    workspace.files.set("src/caller.ts", "export const route = () => Gateway();\n");
    const originalSearch = workspace.searchProject.bind(workspace);
    workspace.searchProject = async (query: string) => {
      workspace.searchQueries.push(query);
      if (workspace.failSearchQuery === query) {
        throw Object.assign(new Error("denied"), { code: "PATH_ACCESS_DENIED" });
      }
      const path = query === '"dependencies"' || query === '"scripts"'
        ? "package.json"
        : query === "main"
          ? "src/index.ts"
          : query === "config"
            ? "src/config.ts"
            : query === "Gateway("
              ? "src/caller.ts"
              : "src/gateway.ts";
      const text = workspace.files.get(path)!;
      return {
        query,
        matches: [{ path, line: 1, column: 1, startLine: 1, endLine: 1, excerpt: text.trimEnd(), fileHash: sha256Text(text) }],
        inspectedPaths: [path],
        truncated: false,
      };
    };
    const session = await service.createSession("root-fixture", "README.md", {});
    const { runId } = await service.startQuestion(session.id, {
      question: "How does the Gateway architecture route requests from its entry point?",
      startOffset: 9,
      endOffset: 26,
    });
    expect((await waitTerminal(service, runId)).type).toBe("completed");

    expect(workspace.searchQueries.length).toBeLessThanOrEqual(12);
    expect(workspace.searchQueries).toEqual(expect.arrayContaining([
      '"dependencies"',
      '"scripts"',
      "main",
      "config",
      "Gateway",
      "Gateway(",
    ]));
    expect(new Set(bridge.asks[0]!.packets.flatMap((packet) => packet.evidence.map(({ path }) => path))))
      .toEqual(new Set(["README.md", "package.json", "src/index.ts", "src/config.ts", "src/caller.ts", "src/gateway.ts"]));
    workspace.searchProject = originalSearch;
  });

  it("discards all project evidence if any supplemental architecture search fails", async () => {
    const { service, workspace, bridge } = makeService();
    workspace.failSearchQuery = '"dependencies"';
    const session = await service.createSession("root-fixture", "README.md", {});
    const { runId } = await service.startQuestion(session.id, {
      question: "How does the Gateway architecture route work?",
      startOffset: 9,
      endOffset: 26,
    });
    const terminal = await waitTerminal(service, runId);
    expect(terminal.type).toBe("completed");
    if (terminal.type !== "completed") throw new Error("expected completion");
    expect(workspace.searchQueries).toContain('"dependencies"');
    expect(terminal.payload.answer.contextMode).toBe("document_only");
    expect(bridge.asks[0]!.packets.flatMap((packet) => packet.evidence.map(({ path }) => path))).toEqual(["README.md"]);
  });

  it("starts a new generation and reissues union evidence when expansion adds a file", async () => {
    const { service, bridge } = makeService();
    bridge.mode = "expand";
    const session = await service.createSession("root-fixture", "README.md", {});
    const { runId } = await service.startQuestion(session.id, { question: "How does work enter?", startOffset: 9, endOffset: 26 });
    expect((await waitTerminal(service, runId)).type).toBe("completed");
    expect(bridge.asks).toHaveLength(2);
    expect(bridge.asks[1]!.generation).not.toBe(bridge.asks[0]!.generation);
    expect(new Set(bridge.asks[1]!.packets.flatMap((packet) => packet.evidence.map(({ path }) => path)))).toEqual(new Set(["README.md", "src/gateway.ts", "src/helper.ts"]));
  });

  it("fails safely after at most two evidence expansion requests", async () => {
    const { service, bridge } = makeService();
    bridge.mode = "expand_forever";
    const session = await service.createSession("root-fixture", "README.md", {});
    const { runId } = await service.startQuestion(session.id, { question: "Keep searching", startOffset: 9, endOffset: 26 });
    expect((await waitTerminal(service, runId)).type).toBe("failed");
    expect(bridge.asks).toHaveLength(3);
  });

  it("recovers formerly active durable drafts under a new generation and invalidates old cursors", async () => {
    const { service, repository } = makeService();
    const session = await service.createSession("root-fixture", "README.md", {});
    await repository.saveDraft({
      id: "run-before-restart",
      sessionId: session.id,
      question: "Interrupted question",
      status: "streaming_unverified",
      generation: "generation-before-restart",
    });
    expect(await service.recoverInterruptedRuns()).toBe(1);
    const changed = await service.pollQuestion("run-before-restart", {
      runId: "run-before-restart",
      generation: "generation-before-restart",
      sequence: 1,
    });
    expect(changed).toMatchObject({
      outcome: "GENERATION_CHANGED",
      runId: "run-before-restart",
    });
    if (changed.outcome !== "GENERATION_CHANGED") throw new Error("expected generation change");
    expect(changed.generation).not.toBe("generation-before-restart");
    const terminal = await waitTerminal(service, "run-before-restart");
    expect(terminal).toMatchObject({ type: "failed", payload: { code: "SERVER_RESTARTED" } });
    expect(await repository.getDraft("run-before-restart")).toMatchObject({
      status: "failed",
      generation: changed.generation,
    });
  });

  it("keeps recovered run routing bounded when durable active drafts exceed capacity", async () => {
    const { service, repository } = makeService("verified", { runCapacity: 2 });
    const session = await service.createSession("root-fixture", "README.md", {});
    for (const id of ["run-recovery-1", "run-recovery-2", "run-recovery-3"]) {
      await repository.saveDraft({
        id,
        sessionId: session.id,
        question: `Interrupted ${id}`,
        status: "streaming_unverified",
        generation: `generation-${id}`,
      });
    }

    expect(await service.recoverInterruptedRuns()).toBe(3);
    await expect(service.authorizeAccess({ kind: "run", id: "run-recovery-1" }))
      .rejects.toMatchObject({ code: "RUN_NOT_FOUND" });
    await expect(service.authorizeAccess({ kind: "run", id: "run-recovery-2" }))
      .resolves.toBeUndefined();
    await expect(service.authorizeAccess({ kind: "run", id: "run-recovery-3" }))
      .resolves.toBeUndefined();
  });

  it("cleans routed run ownership synchronously when a terminal run is evicted", async () => {
    const { service } = makeService("verified", { runCapacity: 2 });
    const session = await service.createSession("root-fixture", "README.md", {});
    const runIds: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const { runId } = await service.startQuestion(session.id, {
        question: `How does work enter ${index}?`,
        startOffset: 9,
        endOffset: 26,
      });
      runIds.push(runId);
      expect((await waitTerminal(service, runId)).type).toBe("completed");
    }

    await expect(service.authorizeAccess({ kind: "run", id: runIds[0]! }))
      .rejects.toMatchObject({ code: "RUN_NOT_FOUND" });
    await expect(service.authorizeAccess({ kind: "run", id: runIds[1]! }))
      .resolves.toBeUndefined();
    await expect(service.authorizeAccess({ kind: "run", id: runIds[2]! }))
      .resolves.toBeUndefined();
  });

  it("prepares only exact accepted annotations and consumes approval after an exclusive sibling write", async () => {
    const { service, workspace, writes } = makeService();
    const session = await service.createSession("root-fixture", "README.md", {});
    const { runId } = await service.startQuestion(session.id, { question: "How does work enter?", startOffset: 9, endOffset: 26 });
    expect((await waitTerminal(service, runId)).type).toBe("completed");
    await service.setDisposition(runId, "inline");
    const preview = await service.preparePatch(session.id, [runId]);
    expect(preview.status).toBe("ready");
    const approval = await service.approvePatch(session.id, preview.sourceHash, preview.diffHash);
    const written = await service.writeExplained(session.id, preview.id, approval.approvalToken);
    expect(written.path).toBe("README.explained.md");
    expect(writes).toEqual(["README.explained.md"]);
    await expect(service.writeExplained(session.id, preview.id, approval.approvalToken)).rejects.toMatchObject({ code: "APPROVAL_INVALID" });

    workspace.files.delete("README.explained.md");
    const secondApproval = await service.approvePatch(session.id, preview.sourceHash, preview.diffHash);
    const writer = service.dependencies.writer.createExplainedSibling;
    service.dependencies.writer.createExplainedSibling = async () => {
      throw Object.assign(new Error("racing writer"), { code: "OUTPUT_ALREADY_EXISTS" });
    };
    await expect(service.writeExplained(session.id, preview.id, secondApproval.approvalToken)).rejects.toMatchObject({ code: "OUTPUT_ALREADY_EXISTS" });
    service.dependencies.writer.createExplainedSibling = writer;
  });

  it.each([
    ["source", "SOURCE_CHANGED"],
    ["evidence", "ANNOTATION_NOT_ACCEPTED"],
  ] as const)("rejects a patch when %s changes during synthesis", async (mutation, code) => {
    const { service, bridge } = makeService();
    const session = await service.createSession("root-fixture", "README.md", {});
    const { runId } = await service.startQuestion(session.id, {
      question: "How does work enter?",
      startOffset: 9,
      endOffset: 26,
    });
    expect((await waitTerminal(service, runId)).type).toBe("completed");
    await service.setDisposition(runId, "inline");
    bridge.synthesizeMutation = mutation;
    await expect(service.preparePatch(session.id, [runId])).rejects.toMatchObject({ code });
  });

  it("revalidates accepted evidence at write time and releases the approval reservation on rejection", async () => {
    const { service, workspace } = makeService();
    const session = await service.createSession("root-fixture", "README.md", {});
    const { runId } = await service.startQuestion(session.id, {
      question: "How does work enter?",
      startOffset: 9,
      endOffset: 26,
    });
    expect((await waitTerminal(service, runId)).type).toBe("completed");
    await service.setDisposition(runId, "inline");
    const preview = await service.preparePatch(session.id, [runId]);
    const approval = await service.approvePatch(session.id, preview.sourceHash, preview.diffHash);

    const originalEvidence = workspace.files.get("src/gateway.ts")!;
    workspace.files.set("src/gateway.ts", "export const changedAfterPreview = true;\n");
    await expect(
      service.writeExplained(session.id, preview.id, approval.approvalToken),
    ).rejects.toMatchObject({ code: "ANNOTATION_NOT_ACCEPTED" });

    workspace.files.set("src/gateway.ts", originalEvidence);
    await expect(
      service.writeExplained(session.id, preview.id, approval.approvalToken),
    ).resolves.toEqual({ path: "README.explained.md" });
  });

  it("keeps an approval reserved through writer I/O even when its original TTL expires", async () => {
    let now = Date.parse("2026-09-01T00:00:00.000Z");
    let tokenSeed = 0;
    const approvalAuthority = createApprovalAuthority({
      now: () => now,
      ttlMs: 25,
      randomBytes: () => new Uint8Array(32).fill(++tokenSeed),
    });
    const { service } = makeService("verified", { approvalAuthority });
    const originalWrite = service.dependencies.writer.createExplainedSibling.bind(service.dependencies.writer);
    service.dependencies.writer.createExplainedSibling = async (...arguments_) => {
      now = Date.parse("2026-09-01T00:00:01.000Z");
      return originalWrite(...arguments_);
    };
    const session = await service.createSession("root-fixture", "README.md", {});
    const { runId } = await service.startQuestion(session.id, {
      question: "How does work enter?",
      startOffset: 9,
      endOffset: 26,
    });
    expect((await waitTerminal(service, runId)).type).toBe("completed");
    await service.setDisposition(runId, "inline");
    const preview = await service.preparePatch(session.id, [runId]);
    const approval = await service.approvePatch(session.id, preview.sourceHash, preview.diffHash);

    await expect(
      service.writeExplained(session.id, preview.id, approval.approvalToken),
    ).resolves.toEqual({ path: "README.explained.md" });
    await expect(
      service.writeExplained(session.id, preview.id, approval.approvalToken),
    ).rejects.toMatchObject({ code: "APPROVAL_INVALID" });
  });

  it("releases an approval reservation when the exclusive writer reports an existing output", async () => {
    const { service } = makeService();
    const session = await service.createSession("root-fixture", "README.md", {});
    const { runId } = await service.startQuestion(session.id, {
      question: "How does work enter?",
      startOffset: 9,
      endOffset: 26,
    });
    expect((await waitTerminal(service, runId)).type).toBe("completed");
    await service.setDisposition(runId, "inline");
    const preview = await service.preparePatch(session.id, [runId]);
    const approval = await service.approvePatch(session.id, preview.sourceHash, preview.diffHash);

    const originalWrite = service.dependencies.writer.createExplainedSibling.bind(service.dependencies.writer);
    let attempts = 0;
    service.dependencies.writer.createExplainedSibling = async (...arguments_) => {
      attempts += 1;
      if (attempts === 1) {
        throw Object.assign(new Error("racing writer"), { code: "OUTPUT_ALREADY_EXISTS" });
      }
      return originalWrite(...arguments_);
    };
    await expect(
      service.writeExplained(session.id, preview.id, approval.approvalToken),
    ).rejects.toMatchObject({ code: "OUTPUT_ALREADY_EXISTS" });
    await expect(
      service.writeExplained(session.id, preview.id, approval.approvalToken),
    ).resolves.toEqual({ path: "README.explained.md" });
  });

  it("does not invoke accessor-shaped writer error codes", async () => {
    const { service } = makeService();
    const session = await service.createSession("root-fixture", "README.md", {});
    const { runId } = await service.startQuestion(session.id, { question: "How does work enter?", startOffset: 9, endOffset: 26 });
    expect((await waitTerminal(service, runId)).type).toBe("completed");
    await service.setDisposition(runId, "inline");
    const preview = await service.preparePatch(session.id, [runId]);
    const approval = await service.approvePatch(session.id, preview.sourceHash, preview.diffHash);
    let reads = 0;
    service.dependencies.writer.createExplainedSibling = async () => {
      throw Object.defineProperty(new Error("private writer failure"), "code", {
        get() {
          reads += 1;
          return "OUTPUT_ALREADY_EXISTS";
        },
      });
    };
    await expect(
      service.writeExplained(session.id, preview.id, approval.approvalToken),
    ).rejects.toMatchObject({ code: "SAFE_WRITE_UNAVAILABLE" });
    expect(reads).toBe(0);
  });

  it("rejects typed synthesis conflicts before an approval can be minted", async () => {
    const { service, bridge } = makeService();
    const original = bridge.synthesize.bind(bridge);
    bridge.synthesize = async (...args) => {
      const result = await original(...args);
      if (result.status !== "completed") return result;
      const annotationId = args[1].annotations[0]!.annotationId;
      return { status: "completed" as const, output: { intents: [], conflicts: [{ annotationId, reason: "Conflicting accepted explanations." }] } };
    };
    const session = await service.createSession("root-fixture", "README.md", {});
    const { runId } = await service.startQuestion(session.id, { question: "How does work enter?", startOffset: 9, endOffset: 26 });
    expect((await waitTerminal(service, runId)).type).toBe("completed");
    await service.setDisposition(runId, "inline");
    const preview = await service.preparePatch(session.id, [runId]);
    expect(preview.status).toBe("conflict");
    await expect(service.approvePatch(session.id, preview.sourceHash, preview.diffHash)).rejects.toMatchObject({ code: "PATCH_NOT_APPROVABLE" });
  });

  it("turns omitted or invented synthesis authority into a non-approvable conflict preview", async () => {
    const { service, bridge } = makeService();
    bridge.synthesize = async () => ({
      status: "completed" as const,
      output: { intents: [], conflicts: [{ annotationId: "invented-annotation", reason: "Invented output." }] },
    });
    const session = await service.createSession("root-fixture", "README.md", {});
    const { runId } = await service.startQuestion(session.id, { question: "How does work enter?", startOffset: 9, endOffset: 26 });
    expect((await waitTerminal(service, runId)).type).toBe("completed");
    await service.setDisposition(runId, "inline");
    const preview = await service.preparePatch(session.id, [runId]);
    expect(preview).toMatchObject({
      status: "conflict",
      conflicts: [{ annotationId: runId, reason: "ANNOTATION_COVERAGE_MISMATCH" }],
    });
    await expect(service.approvePatch(session.id, preview.sourceHash, preview.diffHash)).rejects.toMatchObject({ code: "PATCH_NOT_APPROVABLE" });
  });
});

describe("InMemoryQuestionRunStore", () => {
  it("deduplicates exact replay, rejects gaps, reports generation changes and expires old cursors", async () => {
    const runs = new InMemoryQuestionRunStore({ maxEvents: 2 });
    runs.create("run-1", "generation-1");
    const event = { runId: "run-1", generation: "generation-1", sequence: 1, createdAt: "2026-09-01T00:00:00.000Z", type: "status" as const, payload: { status: "queued" as const } };
    runs.append(event);
    runs.append(event);
    expect(() => runs.append({ ...event, sequence: 3 })).toThrowError(ReaderServiceError);
    runs.append({ ...event, sequence: 2, payload: { status: "inspecting" as const } });
    runs.append({ ...event, sequence: 3, payload: { status: "validating" as const } });
    expect(runs.poll("run-1", { runId: "run-1", generation: "generation-1", sequence: 1 })).toMatchObject({
      outcome: "events",
      events: [{ sequence: 2 }, { sequence: 3 }],
    });
    runs.append({ ...event, sequence: 4, payload: { status: "validating" as const } });
    const expired = runs.poll("run-1", { runId: "run-1", generation: "generation-1", sequence: 1 });
    expect(QuestionRunPageSchema.parse(expired).outcome).toBe("CURSOR_EXPIRED");
    runs.changeGeneration("run-1", "generation-2");
    const changed = runs.poll("run-1", { runId: "run-1", generation: "generation-1", sequence: 3 });
    expect(QuestionRunPageSchema.parse(changed).outcome).toBe("GENERATION_CHANGED");
  });

  it("keeps terminal replay stable and rejects any event after the terminal", () => {
    const runs = new InMemoryQuestionRunStore();
    runs.create("run-terminal", "generation-terminal");
    const terminal = {
      runId: "run-terminal",
      generation: "generation-terminal",
      sequence: 1,
      createdAt: "2026-09-01T00:00:00.000Z",
      type: "failed" as const,
      payload: { status: "failed" as const, code: "QUESTION_FAILED", message: "Failed safely.", retryable: true },
    };
    runs.append(terminal);
    runs.append(terminal);
    const cursor = { runId: "run-terminal", generation: "generation-terminal", sequence: 1 };
    expect(runs.poll("run-terminal", cursor)).toEqual({
      outcome: "events",
      runId: "run-terminal",
      generation: "generation-terminal",
      cursor,
      nextCursor: cursor,
      events: [],
    });
    expect(() => runs.append({ ...terminal, sequence: 2 })).toThrowError(ReaderServiceError);
  });

  it("evicts the oldest terminal run at capacity without evicting active runs", () => {
    const runs = new InMemoryQuestionRunStore({ maxRuns: 2 });
    runs.create("run-terminal", "generation-terminal");
    runs.append({
      runId: "run-terminal",
      generation: "generation-terminal",
      sequence: 1,
      createdAt: "2026-09-01T00:00:00.000Z",
      type: "failed",
      payload: { status: "failed", code: "QUESTION_FAILED", message: "Failed safely.", retryable: true },
    });
    runs.create("run-active", "generation-active");
    expect(runs.create("run-new", "generation-new")).toBe("run-terminal");

    expect(() => runs.poll("run-terminal")).toThrowError(ReaderServiceError);
    expect(runs.poll("run-active")).toMatchObject({ outcome: "events", runId: "run-active" });
    expect(runs.poll("run-new")).toMatchObject({ outcome: "events", runId: "run-new" });
  });
});
