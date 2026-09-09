import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  MAX_SERVER_OWNED_TURN_INPUT_BYTES,
  SERVER_OWNED_MODEL_POLICY,
  buildEvidenceAuditTurn,
  buildQuestionTurn,
  buildReadOnlyThreadStartParams,
  buildReadOnlyTurnStartParams,
  buildAppServerLaunchArguments,
  buildSynthesisTurn,
} from "./policy.js";
import {
  evaluateModelIsolationCapability,
  GENERATED_THREAD_ITEM_TYPES,
  SAFE_MODEL_ITEM_TYPES,
  inspectModelEvent,
  type ModelIsolationProof,
} from "./isolation.js";

function completeProof(): ModelIsolationProof {
  return {
    approvalPolicy: "never",
    sandboxPolicy: { type: "readOnly", networkAccess: false },
    cwd: "non_project_empty",
    runtimeWorkspaceRoots: [],
    environments: [],
    dynamicTools: [],
    selectedCapabilityRoots: [],
    developerPolicy: "server_owned",
    outputSchema: true,
    cancellation: true,
    effectiveTools: {
      mcpServers: [],
      connectors: [],
      apps: [],
      web: false,
      browser: false,
      computerUse: false,
      collaboration: false,
      shell: false,
      patch: false,
      externalTools: [],
    },
  };
}

const DIGEST = "a".repeat(64);
const SECOND_DIGEST = "b".repeat(64);

function sourceAnchor() {
  return {
    documentPath: "docs/design.md",
    documentHash: DIGEST,
    headingPath: ["Architecture"],
    selectedText: "gateway",
    prefix: "The ",
    suffix: " routes requests.",
    startOffset: 4,
    endOffset: 11,
  };
}

function projectEvidence(index = 1) {
  return {
    id: `evidence-${index}`,
    kind: "code_excerpt" as const,
    path: `src/module-${index}.ts`,
    startLine: 1,
    endLine: 1,
    excerpt: "export const gateway = true;",
    excerptHash: SECOND_DIGEST,
    fileHash: SECOND_DIGEST,
    snapshotDigest: DIGEST,
    provenance: {
      issuer: "workspace_service" as const,
      packetId: "packet-1",
      runId: "run-1",
      generation: "generation-1",
    },
  };
}

function evidencePacket() {
  return {
    version: 1 as const,
    runId: "run-1",
    generation: "generation-1",
    snapshotDigest: DIGEST,
    packetIds: ["packet-1"],
    evidence: [projectEvidence()],
  };
}

function citationValidatedAnswer() {
  return {
    conclusionClaimId: "claim-1",
    runId: "run-1",
    generation: "generation-1",
    candidateDigest: SECOND_DIGEST,
    claims: [
      {
        id: "claim-1",
        statement: "The gateway is exported.",
        category: "code_fact" as const,
        evidenceIds: ["evidence-1"],
      },
    ],
    reviewStatus: "citation_validated" as const,
    contextMode: "project_only" as const,
    documentPath: "docs/design.md",
    evidence: [projectEvidence()],
    unknowns: [],
    snapshotDigest: DIGEST,
  };
}

describe("read-only App Server policy", () => {
  it("launches one stdio server with only schema-backed strict overrides", () => {
    expect(buildAppServerLaunchArguments()).toEqual([
      "app-server",
      "--stdio",
      "--strict-config",
      "-c",
      'approval_policy="never"',
      "-c",
      'sandbox_mode="read-only"',
      "-c",
      'web_search="disabled"',
      "-c",
      "tools.web_search=null",
      "-c",
      "analytics.enabled=false",
      "-c",
      "apps._default.enabled=false",
    ]);
  });

  it("serializes only generated thread/start controls and leaves no inherited dynamic surface", () => {
    expect(
      buildReadOnlyThreadStartParams({
        emptyCwd: "C:\\Temp\\aimd-empty",
        developerInstructions: "server-owned policy",
      }),
    ).toEqual({
      cwd: "C:\\Temp\\aimd-empty",
      runtimeWorkspaceRoots: [],
      approvalPolicy: "never",
      sandbox: "read-only",
      config: {
        approval_policy: "never",
        sandbox_mode: "read-only",
        web_search: "disabled",
        tools: { web_search: null },
        analytics: { enabled: false },
        apps: {
          _default: {
            enabled: false,
            approvals_reviewer: null,
            destructive_enabled: false,
            open_world_enabled: false,
            default_tools_approval_mode: null,
          },
        },
      },
      developerInstructions: "server-owned policy",
      ephemeral: true,
      environments: [],
      dynamicTools: [],
      selectedCapabilityRoots: [],
    });
  });

  it("pins every turn to network-disabled read-only with no roots or environments", () => {
    expect(
      buildReadOnlyTurnStartParams({
        threadId: "side_internal",
        emptyCwd: "C:\\Temp\\aimd-empty",
        text: "bounded evidence packet",
        outputSchema: { type: "object" },
      }),
    ).toEqual({
      threadId: "side_internal",
      input: [{ type: "text", text: "bounded evidence packet", text_elements: [] }],
      environments: [],
      cwd: "C:\\Temp\\aimd-empty",
      runtimeWorkspaceRoots: [],
      approvalPolicy: "never",
      sandboxPolicy: { type: "readOnly", networkAccess: false },
      outputSchema: { type: "object" },
    });
  });
});

describe("server-owned model prompt builders", () => {
  it("builds a strict question envelope with policy separated from untrusted data", () => {
    const turn = buildQuestionTurn({
      contextMode: "project_only",
      documentPath: "docs/design.md",
      sourceAnchor: sourceAnchor(),
      question: "How does the gateway work?",
      snapshotDigest: DIGEST,
      evidencePacket: evidencePacket(),
    });

    expect(turn.kind).toBe("question");
    expect(turn.developerInstructions).toBe(SERVER_OWNED_MODEL_POLICY);
    expect(turn.outputSchema).toEqual(
      expect.objectContaining({ oneOf: expect.any(Array) }),
    );
    const decoded = JSON.parse(turn.text) as Record<string, unknown>;
    expect(decoded).toMatchObject({
      schemaVersion: 1,
      operation: "question",
      payload: {
        contextMode: "project_only",
        documentPath: "docs/design.md",
        question: "How does the gateway work?",
        runId: "run-1",
        generation: "generation-1",
        snapshotDigest: DIGEST,
        evidenceRequirements: {
          issuedIdsOnly: true,
          currentProjectFactsRequireProjectEvidence: true,
          architectureMinimumDistinctProjectPaths: 2,
          evidenceExpansion: "typed_request_only",
          taskDecisionEvidenceAllowed: false,
        },
      },
    });
    expect(decoded).not.toHaveProperty("policy");
    expect(turn.text).not.toContain(SERVER_OWNED_MODEL_POLICY);
  });

  it("rejects mismatched anchors, packet snapshots, and unknown input fields", () => {
    expect(() =>
      buildQuestionTurn({
        contextMode: "project_only",
        documentPath: "docs/other.md",
        sourceAnchor: sourceAnchor(),
        question: "Mismatch?",
        snapshotDigest: DIGEST,
        evidencePacket: evidencePacket(),
      }),
    ).toThrowError("MODEL_TURN_INPUT_INVALID");

    expect(() =>
      buildQuestionTurn({
        contextMode: "project_only",
        documentPath: "docs/design.md",
        sourceAnchor: sourceAnchor(),
        question: "Mismatch?",
        snapshotDigest: SECOND_DIGEST,
        evidencePacket: evidencePacket(),
      }),
    ).toThrowError("MODEL_TURN_INPUT_INVALID");

    expect(() =>
      buildQuestionTurn({
        contextMode: "project_only",
        documentPath: "docs/design.md",
        sourceAnchor: sourceAnchor(),
        question: "Unknown field?",
        snapshotDigest: DIGEST,
        evidencePacket: evidencePacket(),
        unexpected: true,
      }),
    ).toThrowError("MODEL_TURN_INPUT_INVALID");

    expect(() =>
      buildQuestionTurn({
        contextMode: "project_only",
        documentPath: "docs/design.md",
        sourceAnchor: sourceAnchor(),
        question: "Untrusted raw packet?",
        snapshotDigest: DIGEST,
        evidencePacket: {
          packetId: "packet-1",
          runId: "run-1",
          generation: "generation-1",
          snapshotDigest: DIGEST,
          evidence: [projectEvidence()],
          integrityDigest: SECOND_DIGEST,
        },
      }),
    ).toThrowError("MODEL_TURN_INPUT_INVALID");
  });

  it("does not authorize task-decision claims from inherited context without issued task evidence", () => {
    const turn = buildQuestionTurn({
      contextMode: "task_and_project",
      documentPath: "docs/design.md",
      sourceAnchor: sourceAnchor(),
      question: "Why was this architecture chosen?",
      snapshotDigest: DIGEST,
      evidencePacket: evidencePacket(),
    });
    const decoded = JSON.parse(turn.text) as {
      payload: { evidenceRequirements: { taskDecisionEvidenceAllowed: boolean } };
    };
    expect(decoded.payload.evidenceRequirements.taskDecisionEvidenceAllowed).toBe(false);
  });

  it("enforces a UTF-8 byte budget before returning a question turn", () => {
    const packet = evidencePacket();
    packet.evidence = Array.from({ length: 40 }, (_, index) => ({
      ...projectEvidence(index + 1),
      excerpt: "x".repeat(16_384),
    }));
    expect(new TextEncoder().encode(JSON.stringify(packet)).byteLength).toBeGreaterThan(
      MAX_SERVER_OWNED_TURN_INPUT_BYTES,
    );
    expect(() =>
      buildQuestionTurn({
        contextMode: "project_only",
        documentPath: "docs/design.md",
        sourceAnchor: sourceAnchor(),
        question: "Oversized?",
        snapshotDigest: DIGEST,
        evidencePacket: packet,
      }),
    ).toThrowError("MODEL_TURN_INPUT_TOO_LARGE");
  });

  it("builds an independent audit envelope with only claims and exact evidence", () => {
    const turn = buildEvidenceAuditTurn({ answer: citationValidatedAnswer() });
    expect(turn.kind).toBe("evidence_audit");
    expect(turn.developerInstructions).toBe(SERVER_OWNED_MODEL_POLICY);
    const decoded = JSON.parse(turn.text) as {
      operation: string;
      payload: Record<string, unknown>;
    };
    expect(decoded.operation).toBe("evidence_audit");
    expect(decoded.payload).toMatchObject({
      runId: "run-1",
      generation: "generation-1",
      candidateDigest: SECOND_DIGEST,
      snapshotDigest: DIGEST,
    });
    expect(decoded.payload).toHaveProperty("claims");
    expect(decoded.payload).toHaveProperty("untrustedEvidence");
    expect(decoded.payload).not.toHaveProperty("conclusionClaimId");
    expect(decoded.payload).not.toHaveProperty("supportReview");
  });

  it("builds a synthesis envelope for accepted annotations with current document identity", () => {
    const turn = buildSynthesisTurn({
      documentPath: "docs/design.md",
      documentHash: DIGEST,
      snapshotDigest: DIGEST,
      annotations: [
        {
          annotationId: "annotation-1",
          disposition: "inline",
          anchor: sourceAnchor(),
          claims: citationValidatedAnswer().claims,
          evidence: citationValidatedAnswer().evidence,
        },
      ],
    });
    expect(turn.kind).toBe("synthesis");
    expect(turn.developerInstructions).toBe(SERVER_OWNED_MODEL_POLICY);
    const decoded = JSON.parse(turn.text) as {
      operation: string;
      payload: Record<string, unknown>;
    };
    expect(decoded).toMatchObject({
      operation: "synthesis",
      payload: {
        documentPath: "docs/design.md",
        documentHash: DIGEST,
        snapshotDigest: DIGEST,
      },
    });
    expect(decoded.payload).toHaveProperty("acceptedAnnotations");
  });
});

describe("ModelIsolationCapability", () => {
  it("keeps the fail-closed item allowlist synchronized with the generated schema", () => {
    const generated = readFileSync(
      new URL("../generated/v2/ThreadItem.ts", import.meta.url),
      "utf8",
    );
    const schemaTypes = [...generated.matchAll(/"type": "([^"]+)"/gu)]
      .map((match) => match[1] as string)
      .filter((value, index, values) => values.indexOf(value) === index);
    expect(GENERATED_THREAD_ITEM_TYPES).toEqual(schemaTypes);
    expect(SAFE_MODEL_ITEM_TYPES).toEqual([
      "userMessage",
      "agentMessage",
      "plan",
      "reasoning",
      "contextCompaction",
    ]);
    for (const type of GENERATED_THREAD_ITEM_TYPES) {
      expect(inspectModelEvent({ type }).status).toBe(
        SAFE_MODEL_ITEM_TYPES.includes(type as never) ? "safe" : "breach",
      );
    }
  });

  it("keeps selected capability-root isolation synchronized with thread/start schema", () => {
    const threadStart = readFileSync(
      new URL("../generated/v2/ThreadStartParams.ts", import.meta.url),
      "utf8",
    );
    const turnStart = readFileSync(
      new URL("../generated/v2/TurnStartParams.ts", import.meta.url),
      "utf8",
    );
    expect(threadStart).toMatch(/selectedCapabilityRoots\?: Array<SelectedCapabilityRoot> \| null/u);
    expect(turnStart).not.toMatch(/selectedCapabilityRoots/u);
  });

  it("keeps empty cwd, empty runtime roots, and developer policy synchronized with thread/fork schema", () => {
    const threadFork = readFileSync(
      new URL("../generated/v2/ThreadForkParams.ts", import.meta.url),
      "utf8",
    );
    expect(threadFork).toMatch(/cwd\?: string \| null/u);
    expect(threadFork).toMatch(/runtimeWorkspaceRoots\?: Array<AbsolutePathBuf> \| null/u);
    expect(threadFork).toMatch(/developerInstructions\?: string \| null/u);
  });

  it("does not enable model execution from a structurally complete claim", () => {
    expect(evaluateModelIsolationCapability(completeProof())).toEqual({
      status: "reader_only",
      code: "MODEL_ISOLATION_UNPROVEN",
      missing: ["effectiveTools.hostAttestation"],
    });
  });

  it("reports the missing host attestation instead of trusting partial controls", () => {
    const incomplete = completeProof() as Partial<ModelIsolationProof>;
    delete incomplete.effectiveTools;
    expect(evaluateModelIsolationCapability(incomplete)).toMatchObject({
      status: "reader_only",
      code: "MODEL_ISOLATION_UNPROVEN",
      missing: ["effectiveTools.hostAttestation"],
    });
  });

  it("does not mistake empty claimed capability roots for effective-host proof", () => {
    const incomplete = {
      ...completeProof(),
      selectedCapabilityRoots: [] as const,
    } as Partial<ModelIsolationProof> & { selectedCapabilityRoots?: readonly [] };
    delete incomplete.selectedCapabilityRoots;
    expect(evaluateModelIsolationCapability(incomplete)).toMatchObject({
      status: "reader_only",
      code: "MODEL_ISOLATION_UNPROVEN",
      missing: ["effectiveTools.hostAttestation"],
    });
  });

  it.each([
    ["mcpServers", ["mcp-local"]],
    ["connectors", ["connector"]],
    ["apps", ["app"]],
    ["web", true],
    ["browser", true],
    ["computerUse", true],
    ["collaboration", true],
    ["shell", true],
    ["patch", true],
    ["externalTools", ["unknown"]],
  ] as const)("keeps a claimed %s surface unproven", (field, value) => {
    const proof = completeProof();
    Object.assign(proof.effectiveTools, { [field]: value });
    expect(evaluateModelIsolationCapability(proof)).toMatchObject({
      status: "reader_only",
      code: "MODEL_ISOLATION_UNPROVEN",
      missing: ["effectiveTools.hostAttestation"],
    });
  });

  it("treats any tool-like or unknown App Server event as an isolation breach", () => {
    expect(inspectModelEvent({ type: "agentMessage", text: "safe" })).toEqual({ status: "safe" });
    expect(inspectModelEvent({ type: "mcpToolCall", server: "secret", tool: "read" })).toEqual({
      status: "breach",
      code: "TOOL_ISOLATION_BROKEN",
    });
    expect(inspectModelEvent({ type: "futureToolClass" })).toEqual({
      status: "breach",
      code: "TOOL_ISOLATION_BROKEN",
    });
  });
});
