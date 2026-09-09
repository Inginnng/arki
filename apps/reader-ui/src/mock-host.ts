import type { EvidenceAnswer, QuestionRunPage, ReaderSession } from "@aimd/contracts";

import projectIntroductionMarkdown from "../../../docs/project-introduction.zh-CN.md?raw";
import type { PatchPreview, ReaderDocument, ReaderHost, SourcePeek } from "./host.js";

const digest = "a".repeat(64);
const markdownLines = projectIntroductionMarkdown.split(/\r?\n/u);
const introductionLine = markdownLines.findIndex(line => line.startsWith("AIMD Reader 是一个")) + 1;
const writingBoundaryLine = markdownLines.findIndex(line => line.startsWith("它不会让模型直接修改项目文档")) + 1;
const document: ReaderDocument = {
  path: "docs/project-introduction.zh-CN.md",
  hash: digest,
  markdown: projectIntroductionMarkdown,
  headings: markdownLines.flatMap((line, index) => { const match = /^(#{1,6}) (.+)$/u.exec(line); return match ? [{ depth: match[1]!.length, text: match[2]!, line: index + 1 }] : []; }),
  anchorStatus: { status: "current" },
};

const session: ReaderSession = {
  id: "mock-session",
  bindingStatus: "unavailable",
  contextMode: "project_only",
  rootId: "mock-root",
  workspaceLabel: "AIMD 中文项目说明",
  documentPath: document.path,
  degradationReason: "模拟后端使用固定数据：未连接项目服务，也未继承当前 Codex 任务上下文。",
};

function answer(runId: string): EvidenceAnswer {
  return {
    conclusionClaimId: "mock-claim",
    runId,
    generation: "mock-generation",
    candidateDigest: digest,
    claims: [{
      id: "mock-claim",
      statement: "这段内容说明了从源码选区到证据审核，再到精确 diff 审批和安全写入的完整流程。",
      category: "document_literal",
      evidenceIds: ["mock-evidence"],
    }],
    reviewStatus: "evidence_reviewed",
    contextMode: "project_only",
    documentPath: document.path,
    evidence: [{
      id: "mock-evidence",
      kind: "project_document",
      path: document.path,
      startLine: introductionLine,
      endLine: writingBoundaryLine,
      excerpt: markdownLines.slice(introductionLine - 1, writingBoundaryLine).join("\n"),
      excerptHash: digest,
      fileHash: digest,
      snapshotDigest: digest,
      provenance: {
        issuer: "workspace_service",
        packetId: "mock-packet",
        runId,
        generation: "mock-generation",
      },
    }],
    unknowns: [],
    snapshotDigest: digest,
    supportReview: {
      id: "mock-review",
      reviewer: "independent_model",
      modelAssisted: true,
      runId,
      generation: "mock-generation",
      candidateDigest: digest,
      snapshotDigest: digest,
      records: [{
        id: "mock-review-record",
        claimId: "mock-claim",
        evidenceIds: ["mock-evidence"],
        verdict: "directly_supported",
        rationale: "项目文档中的定位与写入边界直接支持这条说明。",
      }],
    },
  };
}

export function createMockReaderHost(): ReaderHost {
  let counter = 0;
  return {
    connect: async () => undefined,
    requestFullscreen: async () => undefined,
    call: async <T,>(tool: Parameters<ReaderHost["call"]>[0]): Promise<T> => {
      if (tool === "aimd_list_roots") {
        return { roots: [{ rootId: "mock-root", workspaceLabel: "AIMD 中文项目说明" }] } as T;
      }
      if (tool === "aimd_list_documents") {
        return {
          documents: [{
            path: document.path,
            title: "AIMD Reader：项目流程与实现方式",
            hash: digest,
          }],
        } as T;
      }
      if (tool === "aimd_read_document") return { document } as T;
      if (tool === "aimd_create_session") return { session } as T;
      if (tool === "aimd_ask_start") {
        counter += 1;
        return { job: { runId: "mock-run-" + counter } } as T;
      }
      if (tool === "aimd_set_disposition") return { status: "updated" } as T;
      if (tool === "aimd_prepare_patch") {
        const explanation = "> 已审核说明：该选区已使用当前项目证据完成核验。";
        const preview: PatchPreview = {
          id: "mock-preview",
          sessionId: session.id,
          status: "ready",
          sourcePath: document.path,
          targetPath: "docs/project-introduction.zh-CN.explained.md",
          sourceHash: digest,
          resultHash: "b".repeat(64),
          diffHash: "c".repeat(64),
          markdown: document.markdown + "\n" + explanation + "\n",
          unifiedDiff: "@@ end @@\n+" + explanation,
          annotationIds: ["mock-run-1"],
          conflicts: [],
        };
        return { preview } as T;
      }
      if (tool === "aimd_approve_patch") {
        return { approval: { approvalToken: "x".repeat(43) } } as T;
      }
      if (tool === "aimd_write_explained") {
        return { result: { path: "docs/project-introduction.zh-CN.explained.md" } } as T;
      }
      throw new Error("Unsupported mock tool: " + tool);
    },
    openSource: async (_rootId: string, path: string, line = 1): Promise<SourcePeek> => {
      const sourceLines = document.markdown.split(/\r?\n/);
      const lines = sourceLines
        .slice(line - 1, line + 2)
        .map((text, index) => ({ line: line + index, text }));
      return {
        path,
        startLine: line,
        endLine: lines.at(-1)?.line ?? line,
        totalLines: sourceLines.length,
        lines,
        excerpt: lines.map((entry) => entry.text).join("\n"),
        fileHash: digest,
        truncated: false,
      };
    },
    watchQuestion: async (runId, onPage, signal) => {
      if (signal.aborted) return;
      const page: QuestionRunPage = {
        outcome: "events",
        runId,
        generation: "mock-generation",
        cursor: null,
        nextCursor: { runId, generation: "mock-generation", sequence: 1 },
        events: [{
          runId,
          generation: "mock-generation",
          sequence: 1,
          createdAt: "2026-09-01T00:00:00.000Z",
          type: "completed",
          payload: { status: "completed", answer: answer(runId) },
        }],
      };
      onPage(page);
    },
  };
}
