import { randomUUID } from "node:crypto";

import {
  ContextBridgeError,
  buildQuestionTurn,
  type AnchoredQuestion,
  type BridgeQuestionEvent,
  type TaskBindingResult,
  type UnverifiedBinding,
} from "@aimd/app-server-bridge";
import {
  OpaqueIdSchema,
  ReaderSessionSchema,
  type ReaderSession,
} from "@aimd/contracts";
import {
  serializeIssuedEvidenceForModel,
  validateEvidenceQuestionOutput,
} from "@aimd/reader-core";

import { sameCanonicalPath } from "./canonical-path.js";
import type { ReaderServiceBridge } from "./service.js";
import type { StructuredAgentRunner } from "./codex-cli-runner.js";

export type CodexCliBridgeOptions = Readonly<{
  canonicalRoot: string;
  rootId: string;
  workspaceLabel: string;
  runner: StructuredAgentRunner;
  onRunStart?: (event: Readonly<{ runId: string; question: string; runnerName: string }>) => void;
  onRunFinish?: (event: Readonly<{
    runId: string;
    status: "cancelled" | "completed" | "failed";
    code?: string;
  }>) => void;
}>;

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function codexAnswerOnlyTurn<T extends Readonly<{
  developerInstructions: string;
  outputSchema: unknown;
}>>(turn: T): T {
  const root = record(turn.outputSchema);
  const branches = Array.isArray(root?.oneOf) ? root.oneOf : [];
  const answerBranches = branches.filter((candidate) => {
    const branch = record(candidate);
    const properties = record(branch?.properties);
    const kind = record(properties?.kind);
    return kind?.const === "answer";
  });
  const answerBranch = record(answerBranches[0]);
  if (answerBranches.length !== 1 || answerBranch === undefined) {
    throw new TypeError("CODEX_ANSWER_SCHEMA_INVALID");
  }
  const { oneOf: _oneOf, ...rootMetadata } = root!;
  return {
    ...turn,
    developerInstructions: [
      turn.developerInstructions,
      "This Codex CLI adapter accepts only the direct answer branch; when evidence is insufficient, record uncertainty in unknowns instead of requesting another evidence turn.",
    ].join(" "),
    outputSchema: { ...rootMetadata, ...answerBranch },
  };
}

export function createCodexCliBridge(options: CodexCliBridgeOptions): ReaderServiceBridge {
  const sessions = new Map<string, ReaderSession>();
  return {
    async verifyBinding(_binding: UnverifiedBinding, workspaceRoot: string): Promise<TaskBindingResult> {
      if (!sameCanonicalPath(workspaceRoot, options.canonicalRoot)) {
        return { status: "mismatch", code: "TASK_WORKSPACE_MISMATCH" };
      }
      return { status: "unavailable", code: "TASK_CONTEXT_UNAVAILABLE" };
    },

    async createSession(
      binding: TaskBindingResult,
      workspaceRoot: string,
      documentPath: string,
    ): Promise<ReaderSession> {
      if (!sameCanonicalPath(workspaceRoot, options.canonicalRoot)) {
        throw new ContextBridgeError("WORKSPACE_AUTHORITY_INVALID");
      }
      const session = ReaderSessionSchema.parse({
        id: OpaqueIdSchema.parse(`session-${randomUUID()}`),
        bindingStatus: binding.status,
        contextMode: "project_only",
        rootId: options.rootId,
        workspaceLabel: options.workspaceLabel,
        documentPath,
        degradationReason: "本机 Codex CLI 已启用；当前网页会话不包含桌面任务上下文，严格工具隔离也尚未获主机证明。",
      });
      sessions.set(session.id, session);
      return session;
    },

    async *ask(
      sessionId: string,
      question: AnchoredQuestion,
      signal?: AbortSignal,
    ): AsyncIterable<BridgeQuestionEvent> {
      const session = sessions.get(sessionId);
      if (!session) {
        yield { type: "failed", code: "SESSION_NOT_FOUND" };
        return;
      }
      try {
        const packet = serializeIssuedEvidenceForModel({
          packets: question.evidencePackets,
          expectedRunId: question.runId,
          expectedGeneration: question.generation,
          expectedSnapshotDigest: question.snapshotDigest,
        });
        const issuedEvidenceIds = new Set(packet.evidence.map((evidence) => evidence.id));
        const turn = codexAnswerOnlyTurn(buildQuestionTurn({
          contextMode: question.contextMode,
          documentPath: session.documentPath,
          sourceAnchor: question.sourceAnchor,
          question: question.question,
          snapshotDigest: question.snapshotDigest,
          evidencePacket: packet,
        }));
        options.onRunStart?.({
          runId: question.runId,
          question: question.question,
          runnerName: options.runner.name,
        });
        yield { type: "progress", phase: "started" };
        const output = validateEvidenceQuestionOutput(
          await options.runner.runStructured(turn, signal),
          question.expansionRequestsUsed,
        );
        if (output.kind === "answer") {
          const citedIds = [
            ...output.answer.claims.flatMap((claim) => claim.evidenceIds),
            ...output.answer.unknowns.flatMap((unknown) => unknown.evidenceIds),
          ];
          if (
            citedIds.some((id) => !issuedEvidenceIds.has(id)) ||
            output.answer.claims.some((claim) => claim.category === "task_decision")
          ) throw new TypeError("MODEL_EVIDENCE_INVALID");
        }
        options.onRunFinish?.({ runId: question.runId, status: "completed" });
        yield { type: "completed", output };
      } catch (error) {
        if (signal?.aborted || (error instanceof Error && error.message === "CODEX_CANCELLED")) {
          options.onRunFinish?.({ runId: question.runId, status: "cancelled" });
          yield { type: "cancelled" };
          return;
        }
        const code = error instanceof Error && error.message === "CODEX_OUTPUT_INVALID"
          ? "MODEL_OUTPUT_INVALID"
          : error instanceof Error && error.message === "CODEX_TOOL_ISOLATION_BROKEN"
            ? "TOOL_ISOLATION_BROKEN"
            : "APP_SERVER_TURN_FAILED";
        options.onRunFinish?.({ runId: question.runId, status: "failed", code });
        yield {
          type: "failed",
          code,
        };
      }
    },

    async auditEvidence() {
      return { status: "failed", code: "MODEL_ISOLATION_UNPROVEN" };
    },

    issueAcceptedSynthesisAnnotation() {
      throw new ContextBridgeError("MODEL_ISOLATION_UNPROVEN");
    },

    async synthesize() {
      return { status: "failed", code: "MODEL_ISOLATION_UNPROVEN" };
    },
  };
}
