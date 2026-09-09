import { describe, expect, it } from "vitest";

import * as publicBridgeApi from "./index.js";

import {
  ModelIsolationCapability,
  evaluateModelIsolationCapability,
  inspectModelEvent,
  normalizeModelIsolationResult,
  type ModelIsolationProof,
} from "./isolation.js";
import { issueModelIsolationAuthorityForTesting } from "./isolation.testing.js";

function completeClaim(): ModelIsolationProof {
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

describe("unforgeable model-isolation capability", () => {
  it("does not expose a test authority issuer from the production package entry", () => {
    expect("issueModelIsolationAuthorityForTesting" in publicBridgeApi).toBe(false);
  });

  it("does not treat a complete ordinary object as host-attested proof", () => {
    expect(evaluateModelIsolationCapability(completeClaim())).toEqual({
      status: "reader_only",
      code: "MODEL_ISOLATION_UNPROVEN",
      missing: ["effectiveTools.hostAttestation"],
    });
  });

  it("keeps the 0.151 capability fixed unproven through the public wrapper", () => {
    expect(new ModelIsolationCapability().evaluate(completeClaim())).toEqual({
      status: "reader_only",
      code: "MODEL_ISOLATION_UNPROVEN",
      missing: ["effectiveTools.hostAttestation"],
    });
  });

  it("does not accept a structurally enabled result from a dependency-injected client", () => {
    expect(normalizeModelIsolationResult({
      status: "enabled",
      capability: "empty-model-tool-surface",
    })).toEqual({
      status: "reader_only",
      code: "MODEL_ISOLATION_UNPROVEN",
      missing: ["effectiveTools.hostAttestation"],
    });

    expect(normalizeModelIsolationResult(issueModelIsolationAuthorityForTesting())).toMatchObject({
      status: "enabled",
      capability: "empty-model-tool-surface",
    });
  });
});

describe("model event inspection", () => {
  it("accepts only an own data-property safe type", () => {
    expect(inspectModelEvent({ type: "agentMessage" })).toEqual({ status: "safe" });
    expect(inspectModelEvent(Object.create({ type: "agentMessage" }))).toEqual({
      status: "breach",
      code: "TOOL_ISOLATION_BROKEN",
    });
  });

  it("does not execute a type accessor and fails closed on descriptor traps", () => {
    let getterCalls = 0;
    const accessor = Object.defineProperty({}, "type", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "agentMessage";
      },
    });
    const trapped = new Proxy({}, {
      getOwnPropertyDescriptor() {
        throw new Error("secret transport failure");
      },
    });

    expect(inspectModelEvent(accessor)).toEqual({
      status: "breach",
      code: "TOOL_ISOLATION_BROKEN",
    });
    expect(inspectModelEvent(trapped)).toEqual({
      status: "breach",
      code: "TOOL_ISOLATION_BROKEN",
    });
    expect(getterCalls).toBe(0);
  });
});
