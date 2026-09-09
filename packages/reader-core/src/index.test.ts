import { describe, expect, it } from "vitest";

import {
  applyEditIntents,
  createApprovalAuthority,
  createSourceAnchor,
  createWorkspaceSnapshot,
  defaultExplainedPath,
  issueEvidencePacket,
  relocateSourceAnchor,
  sha256,
  snapshotDigest,
  validateEvidence,
  validateSynthesisOutput,
} from "./index.js";

describe("reader-core public entry point", () => {
  it("exports the reviewed anchor, snapshot, hash, and project-evidence APIs", () => {
    expect([
      sha256,
      createSourceAnchor,
      relocateSourceAnchor,
      createWorkspaceSnapshot,
      snapshotDigest,
      issueEvidencePacket,
      validateEvidence,
      applyEditIntents,
      defaultExplainedPath,
      createApprovalAuthority,
      validateSynthesisOutput,
    ]).toSatisfy((values: unknown[]) => values.every((value) => typeof value === "function"));
  });
});
