import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type { ModelAnswerCandidate } from "../../packages/contracts/src/index.js";
import type { BridgeOperationResult } from "../../packages/app-server-bridge/src/index.js";
import {
  createApprovalAuthority,
  createSourceAnchor,
  sha256Text,
  type EvidencePacket,
} from "../../packages/reader-core/src/index.js";
import {
  MemoryAnnotationRepository,
  ReaderService,
  openReadOnlyWorkspaceForTesting,
  type ReaderServiceBridge,
} from "../../packages/workspace-server/src/index.js";
import { afterEach, describe, expect, it } from "vitest";

const SAMPLE_PROJECT = resolve("tests/fixtures/sample-project");
const PARENT_THREAD_SENTINEL = "parent-thread-must-stay-internal";
const QUESTION = "How does the request pipeline architecture connect gateway and worker?";
const SELECTED_PATTERN =
  /`src\/gateway\.ts` validates an incoming request and forwards a normalized job to\r?\n`src\/worker\.ts`\./u;
const temporaryRoots: string[] = [];

function selectedRange(markdown: string): { startOffset: number; endOffset: number } {
  const match = SELECTED_PATTERN.exec(markdown);
  if (!match) {
    throw new Error("Integration selection fixture is missing");
  }
  return {
    startOffset: match.index,
    endOffset: match.index + match[0].length,
  };
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

type BridgeMode = "supported" | "stale" | "hallucinated_citation";

class IntegrationBridge implements ReaderServiceBridge {
  mode: BridgeMode = "supported";
  readonly observedBindings: unknown[] = [];
  readonly observedPackets: EvidencePacket[][] = [];

  constructor(
    private readonly root: string,
    private readonly readme: string,
  ) {}

  async verifyBinding(binding: unknown) {
    this.observedBindings.push(binding);
    return { status: "verified" as const, bindingId: "binding-fixture", cutoffLabel: "Through the latest completed parent turn" };
  }

  async createSession(_binding: unknown, _workspaceRoot: string, documentPath: string) {
    return {
      id: "session-integration",
      bindingStatus: "verified" as const,
      contextMode: "task_and_project" as const,
      rootId: "root-integration",
      workspaceLabel: "sample-project",
      documentPath,
      cutoffLabel: "Through the latest completed parent turn",
    };
  }

  async *ask(_sessionId: string, question: Parameters<ReaderServiceBridge["ask"]>[1]) {
    this.observedPackets.push([...question.evidencePackets]);
    yield { type: "progress" as const, phase: "started" as const };
    const evidence = question.evidencePackets.flatMap((packet) => packet.evidence);
    const requiredPaths = ["src/gateway.ts", "src/worker.ts"];
    if (
      this.mode !== "hallucinated_citation" &&
      requiredPaths.some((path) => !evidence.some((candidate) => "path" in candidate && candidate.path === path))
    ) {
      yield {
        type: "completed" as const,
        output: {
          kind: "evidence_request" as const,
          request: { query: "completeJob", reason: "Need both sides of the request boundary", requestedKinds: ["code_excerpt" as const] },
        },
      };
      return;
    }
    if (this.mode === "stale") {
      await writeFile(join(this.root, "src", "gateway.ts"), "export const changedWhileAnswering = true;\n", "utf8");
    }
    const citedIds = this.mode === "hallucinated_citation"
      ? ["evidence-fabricated"]
      : requiredPaths.map((path) => {
          const item = evidence.find((candidate) => "path" in candidate && candidate.path === path);
          if (!item) throw new Error(`Integration evidence missing: ${path}`);
          return item.id;
        });
    const answer: ModelAnswerCandidate = {
      conclusionClaimId: "claim-flow",
      claims: [{
        id: "claim-flow",
        statement: "The gateway normalizes the request before the worker produces the completion record.",
        category: "architecture",
        evidenceIds: citedIds,
      }],
      unknowns: [],
    };
    yield { type: "completed" as const, output: { kind: "answer" as const, answer } };
  }

  async auditEvidence(input: Parameters<ReaderServiceBridge["auditEvidence"]>[0]) {
    return {
      status: "completed" as const,
      output: {
        reviewStatus: "evidence_reviewed" as const,
        supportReview: {
          id: "review-integration",
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
            verdict: "directly_supported" as const,
            rationale: "The two current code excerpts directly support the architecture statement.",
          })),
        },
        unsupportedClaimIds: [],
      },
    };
  }

  issueAcceptedSynthesisAnnotation(
    _sessionId: string,
    input: Parameters<ReaderServiceBridge["issueAcceptedSynthesisAnnotation"]>[1],
  ) {
    const { startOffset, endOffset } = selectedRange(this.readme);
    return {
      annotationId: input.annotationId,
      disposition: input.disposition,
      anchor: createSourceAnchor("README.md", this.readme, startOffset, endOffset),
      claims: input.answer.claims,
      evidence: input.answer.evidence,
    };
  }

  async synthesize(
    _sessionId: string,
    input: Parameters<ReaderServiceBridge["synthesize"]>[1],
  ): Promise<BridgeOperationResult<unknown>> {
    return {
      status: "completed",
      output: {
        intents: input.annotations.map((annotation) => ({
          annotationId: annotation.annotationId,
          operation: "insert_after",
          targetAnchor: annotation.anchor,
          markdown: "\n\n> The gateway-to-worker boundary is verified by current implementation evidence.",
          rationale: "Add the accepted project-grounded explanation next to its source passage.",
          evidenceIds: annotation.evidence.slice(0, 2).map(({ id }) => id),
        })),
        conflicts: [],
      },
    };
  }
}

async function createHarness() {
  const root = await mkdtemp(join(tmpdir(), "aimd-reader-flow-"));
  temporaryRoots.push(root);
  await cp(SAMPLE_PROJECT, root, { recursive: true });
  const readme = await readFile(join(root, "README.md"), "utf8");
  const workspace = await openReadOnlyWorkspaceForTesting(root, {
    rootId: "root-integration",
    searchBackend: "walker",
    gitExecutable: null,
    rgExecutable: null,
  });
  const repository = new MemoryAnnotationRepository({ now: () => new Date("2026-09-04T00:00:00.000Z") });
  const bridge = new IntegrationBridge(root, readme);
  let issued = 0;
  let tokenByte = 0;
  const service = new ReaderService({
    roots: [{
      rootId: "root-integration",
      workspaceLabel: "sample-project",
      canonicalRoot: root,
      workspace,
      listDocuments: async () => [{ path: "README.md", title: "Sample Project", hash: sha256Text(await readFile(join(root, "README.md"), "utf8")) }],
    }],
    repository,
    bridge,
    approvalAuthority: createApprovalAuthority({ randomBytes: () => new Uint8Array(32).fill(++tokenByte) }),
    writer: {
      capability: async () => ({ status: "available" as const, capability: "windows_locked_chain_create_new_v1" as const }),
      createExplainedSibling: async (_source, targetBasename, content) => {
        await writeFile(join(root, targetBasename), content, { flag: "wx" });
        return { targetBasename, byteLength: content.byteLength };
      },
    },
    captureTaskBinding: () => ({ status: "candidate", parentThreadId: PARENT_THREAD_SENTINEL, source: "codex-hidden-meta" }),
    issueId: (scope) => `${scope}-${++issued}`,
    now: () => new Date("2026-09-04T00:00:00.000Z"),
  });
  return { root, readme, repository, bridge, service };
}

async function waitForTerminal(service: ReaderService, runId: string) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const page = await service.pollQuestion(runId);
    if (page.outcome === "events") {
      const terminal = page.events.find((event) => ["completed", "stale", "failed", "cancelled"].includes(event.type));
      if (terminal) return terminal;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Integration question did not reach a terminal state");
}

async function ask(service: ReaderService, readme: string) {
  const session = await service.createSession("root-integration", "README.md", { hidden: "host-owned" });
  const { startOffset, endOffset } = selectedRange(readme);
  const { runId } = await service.startQuestion(session.id, {
    question: QUESTION,
    startOffset,
    endOffset,
  });
  return { session, runId, terminal: await waitForTerminal(service, runId) };
}

describe("project-aware reader integration", () => {
  it("runs the full evidence-reviewed, explicitly approved, non-overwriting flow", async () => {
    const { root, readme, repository, bridge, service } = await createHarness();
    const document = await service.openDocument("root-integration", "README.md");
    const { session, runId, terminal } = await ask(service, readme);

    expect(document.markdown).toBe(readme);
    expect(session).toMatchObject({ bindingStatus: "verified", contextMode: "task_and_project" });
    expect(terminal.type).toBe("completed");
    if (terminal.type !== "completed") throw new Error("Expected completed answer");
    expect(terminal.payload.answer.reviewStatus).toBe("evidence_reviewed");
    expect(terminal.payload.answer.evidence.map((item) => "path" in item ? item.path : item.kind).sort())
      .toEqual(["src/gateway.ts", "src/worker.ts"]);

    const annotation = await repository.getAnnotation(runId);
    expect(annotation).toMatchObject({ id: runId, disposition: "reading_only", stale: false });
    await service.setDisposition(runId, "inline");
    const preview = await service.preparePatch(session.id, [runId]);
    expect(preview).toMatchObject({ status: "ready", sourcePath: "README.md", targetPath: "README.explained.md" });
    const { approvalToken } = await service.approvePatch(session.id, preview.sourceHash, preview.diffHash);
    await expect(readFile(join(root, "README.md"), "utf8")).resolves.toBe(readme);
    await expect(service.writeExplained(session.id, preview.id, approvalToken)).resolves.toEqual({ path: "README.explained.md" });
    await expect(readFile(join(root, "README.explained.md"), "utf8")).resolves.toContain("gateway-to-worker boundary");
    await expect(readFile(join(root, "README.md"), "utf8")).resolves.toBe(readme);

    const publicDtos = JSON.stringify({ document, session, answer: terminal.payload.answer, annotation });
    expect(publicDtos).not.toContain(PARENT_THREAD_SENTINEL);
    expect(publicDtos).not.toMatch(/threadId|parentThreadId|forkedFromId/u);
    expect(bridge.observedBindings).toContainEqual(expect.objectContaining({ parentThreadId: PARENT_THREAD_SENTINEL }));
    expect(bridge.observedPackets.length).toBeGreaterThanOrEqual(2);
  });

  it("marks dirty evidence stale and rejects a fabricated nonexistent-file citation", async () => {
    const stale = await createHarness();
    stale.bridge.mode = "stale";
    const staleRun = await ask(stale.service, stale.readme);
    expect(staleRun.terminal.type).toBe("stale");
    expect(await stale.repository.getAnnotation(staleRun.runId)).toBeUndefined();

    const trapped = await createHarness();
    trapped.bridge.mode = "hallucinated_citation";
    const hallucinated = await ask(trapped.service, trapped.readme);
    expect(hallucinated.terminal.type).toBe("failed");
    expect(JSON.stringify(hallucinated.terminal)).not.toContain("src/nonexistent.ts");
    expect(await trapped.repository.getAnnotation(hallucinated.runId)).toBeUndefined();
  });

  it("invalidates an approval if the source document changes before write", async () => {
    const { root, readme, service } = await createHarness();
    const { session, runId, terminal } = await ask(service, readme);
    expect(terminal.type).toBe("completed");
    await service.setDisposition(runId, "inline");
    const preview = await service.preparePatch(session.id, [runId]);
    const { approvalToken } = await service.approvePatch(session.id, preview.sourceHash, preview.diffHash);
    await writeFile(join(root, "README.md"), `${readme}\nChanged after approval.\n`, "utf8");

    await expect(service.writeExplained(session.id, preview.id, approvalToken)).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    await expect(readFile(join(root, "README.explained.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
