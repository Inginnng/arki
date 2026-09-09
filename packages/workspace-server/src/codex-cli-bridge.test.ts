import { describe, expect, it, vi } from "vitest";
const fixtureRoot = process.platform === "win32" ? "C:\\fixture-project" : "/fixture-project";

import {
  createWorkspaceSnapshot,
  issueEvidencePacket,
  sha256Text,
  type EvidencePacket,
} from "@aimd/reader-core";

import { createCodexCliBridge } from "./codex-cli-bridge.js";
import { CodexCliRunnerError } from "./codex-cli-runner.js";

function fixtureEvidence(runId: string, generation: string) {
  const source = "MCP 是一种让 AI 应用连接外部工具与数据的开放协议。";
  const fileHash = sha256Text(source);
  const snapshot = createWorkspaceSnapshot({
    projectRoot: fixtureRoot,
    rootId: "root-fixture",
    branch: null,
    head: null,
    createdAt: "2026-09-04T00:00:00.000Z",
    gitState: { kind: "dirty", status: "fixture", contentDigest: sha256Text("fixture") },
    relevantFileHashes: [{ path: "README.md", hash: fileHash }],
  });
  const packet: EvidencePacket = issueEvidencePacket({
    runId,
    generation,
    snapshotDigest: snapshot.snapshotDigest,
    sources: [{
      kind: "project_document",
      path: "README.md",
      excerpt: source,
      fileHash,
      sourceLocationKey: "fixture:README.md",
      startLine: 1,
      endLine: 1,
      heading: "MCP",
    }],
  });
  return { source, snapshot, packet };
}

describe("Codex CLI reader bridge", () => {
  it("reports a rejected Codex tool event as an isolation breach", async () => {
    const onRunFinish = vi.fn();
    const bridge = createCodexCliBridge({
      canonicalRoot: fixtureRoot,
      rootId: "root-fixture",
      workspaceLabel: "fixture-project",
      runner: {
        name: "unsafe-codex",
        runStructured: vi.fn(async () => {
          throw new CodexCliRunnerError("CODEX_TOOL_ISOLATION_BROKEN");
        }),
      },
      onRunFinish,
    });
    const session = await bridge.createSession(
      await bridge.verifyBinding({ status: "unavailable" }, fixtureRoot),
      fixtureRoot,
      "README.md",
    );
    const { snapshot, packet } = fixtureEvidence("run-isolation", "generation-isolation");
    const events = [];
    for await (const event of bridge.ask(session.id, {
      question: "MCP 是什么？",
      contextMode: "project_only",
      sourceAnchor: {
        documentPath: "README.md",
        documentHash: packet.evidence[0]!.fileHash,
        headingPath: ["MCP"],
        selectedText: "MCP",
        prefix: "",
        suffix: "",
        startOffset: 0,
        endOffset: 3,
      },
      runId: "run-isolation",
      generation: "generation-isolation",
      snapshotDigest: snapshot.snapshotDigest,
      workspaceSnapshot: snapshot,
      evidencePackets: [packet],
      expansionRequestsUsed: 0,
    })) events.push(event);

    expect(events.at(-1)).toEqual({ type: "failed", code: "TOOL_ISOLATION_BROKEN" });
    expect(onRunFinish).toHaveBeenCalledWith({
      runId: "run-isolation",
      status: "failed",
      code: "TOOL_ISOLATION_BROKEN",
    });
  });

  it("forwards each arbitrary browser question unchanged to the injected runner", async () => {
    const questions = [
      `什么是 MCP？-${crypto.randomUUID()}`,
      `它和本地 Agent 有什么关系？-${crypto.randomUUID()}`,
    ];
    const observed: string[] = [];
    const runner = {
      name: "recording-codex",
      runStructured: vi.fn(async (turn: {
        developerInstructions: string;
        text: string;
        outputSchema: Record<string, unknown>;
      }) => {
        expect(turn.outputSchema).not.toHaveProperty("oneOf");
        expect(turn.outputSchema).toMatchObject({
          type: "object",
          properties: { kind: { const: "answer" } },
        });
        expect(turn.developerInstructions).toContain("record uncertainty in unknowns");
        const envelope = JSON.parse(turn.text) as { payload: { question: string; untrustedEvidencePacket: { evidence: Array<{ id: string }> } } };
        observed.push(envelope.payload.question);
        return {
          kind: "answer",
          answer: {
            conclusionClaimId: "claim-1",
            claims: [{
              id: "claim-1",
              statement: `runner:${sha256Text(envelope.payload.question)}`,
              category: "document_literal",
              evidenceIds: [envelope.payload.untrustedEvidencePacket.evidence[0]!.id],
            }],
            unknowns: [],
          },
        };
      }),
    };
    const bridge = createCodexCliBridge({
      canonicalRoot: fixtureRoot,
      rootId: "root-fixture",
      workspaceLabel: "fixture-project",
      runner,
    });
    const binding = await bridge.verifyBinding({ status: "unavailable" }, fixtureRoot);
    const session = await bridge.createSession(binding, fixtureRoot, "README.md");

    for (const [index, question] of questions.entries()) {
      const runId = `run-${index + 1}`;
      const generation = `generation-${index + 1}`;
      const { snapshot, packet } = fixtureEvidence(runId, generation);
      const events = [];
      for await (const event of bridge.ask(session.id, {
        question,
        contextMode: "project_only",
        sourceAnchor: {
          documentPath: "README.md",
          documentHash: packet.evidence[0]!.fileHash,
          headingPath: ["MCP"],
          selectedText: "MCP",
          prefix: "",
          suffix: "",
          startOffset: 0,
          endOffset: 3,
        },
        runId,
        generation,
        snapshotDigest: snapshot.snapshotDigest,
        workspaceSnapshot: snapshot,
        evidencePackets: [packet],
        expansionRequestsUsed: 0,
      })) events.push(event);
      expect(events.at(-1)).toMatchObject({
        type: "completed",
        output: { kind: "answer", answer: { claims: [{ statement: `runner:${sha256Text(question)}` }] } },
      });
    }

    expect(observed).toEqual(questions);
    expect(runner.runStructured).toHaveBeenCalledTimes(2);
    expect(await bridge.auditEvidence({} as never)).toEqual({
      status: "failed",
      code: "MODEL_ISOLATION_UNPROVEN",
    });
  });
});
