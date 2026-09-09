export type EffectiveModelTools = {
  mcpServers: readonly unknown[];
  connectors: readonly unknown[];
  apps: readonly unknown[];
  web: false;
  browser: false;
  computerUse: false;
  collaboration: false;
  shell: false;
  patch: false;
  externalTools: readonly unknown[];
};

export type ModelIsolationProof = {
  approvalPolicy: "never";
  sandboxPolicy: { type: "readOnly"; networkAccess: false };
  cwd: "non_project_empty";
  runtimeWorkspaceRoots: readonly [];
  environments: readonly [];
  dynamicTools: readonly [];
  selectedCapabilityRoots: readonly [];
  developerPolicy: "server_owned";
  outputSchema: true;
  cancellation: true;
  effectiveTools: EffectiveModelTools;
};

export type ModelIsolationResult =
  | ModelIsolationEnabledAuthority
  | {
      status: "reader_only";
      code: "MODEL_ISOLATION_UNPROVEN";
      missing: string[];
    }
  | {
      status: "reader_only";
      code: "MODEL_ISOLATION_BROKEN";
      present: string[];
    };

function unprovenIsolation(): Extract<ModelIsolationResult, { status: "reader_only" }> {
  return {
    status: "reader_only",
    code: "MODEL_ISOLATION_UNPROVEN",
    missing: ["effectiveTools.hostAttestation"],
  };
}

/**
 * Normalizes a client claim at the bridge boundary. Only an object issued by
 * this module can enable model execution; structural lookalikes stay reader-only.
 */
export function normalizeModelIsolationResult(value: unknown): ModelIsolationResult {
  return authenticateModelIsolationAuthority(value) ?? unprovenIsolation();
}

/**
 * App Server 0.151 accepts restrictive requested controls but exposes no
 * schema-backed effective tool-catalog attestation. A caller-supplied object is
 * therefore only a claim and can never become an execution authority.
 *
 * When a future generated protocol exposes an authenticated effective catalog,
 * its adapter must mint an opaque module-owned authority instead of relaxing
 * this function to accept structurally matching objects.
 */
export function evaluateModelIsolationCapability(
  _claimedProof: Partial<ModelIsolationProof> | unknown,
): ModelIsolationResult {
  return unprovenIsolation();
}

export class ModelIsolationCapability {
  evaluate(proof: Partial<ModelIsolationProof> | unknown): ModelIsolationResult {
    return evaluateModelIsolationCapability(proof);
  }
}

export const GENERATED_THREAD_ITEM_TYPES = [
  "userMessage",
  "hookPrompt",
  "agentMessage",
  "functionCallOutput",
  "plan",
  "reasoning",
  "commandExecution",
  "fileChange",
  "mcpToolCall",
  "dynamicToolCall",
  "collabAgentToolCall",
  "subAgentActivity",
  "webSearch",
  "imageView",
  "sleep",
  "imageGeneration",
  "enteredReviewMode",
  "exitedReviewMode",
  "contextCompaction",
] as const;

export const SAFE_MODEL_ITEM_TYPES = [
  "userMessage",
  "agentMessage",
  "plan",
  "reasoning",
  "contextCompaction",
] as const;

const GENERATED_THREAD_ITEM_TYPE_SET = new Set<string>(GENERATED_THREAD_ITEM_TYPES);
const SAFE_MODEL_ITEM_TYPE_SET = new Set<string>(SAFE_MODEL_ITEM_TYPES);

export function inspectModelEvent(
  event: unknown,
): { status: "safe" } | { status: "breach"; code: "TOOL_ISOLATION_BROKEN" } {
  try {
    if (typeof event !== "object" || event === null || Array.isArray(event)) {
      return { status: "breach", code: "TOOL_ISOLATION_BROKEN" };
    }
    const descriptor = Object.getOwnPropertyDescriptor(event, "type");
    if (
      descriptor &&
      "value" in descriptor &&
      typeof descriptor.value === "string" &&
      GENERATED_THREAD_ITEM_TYPE_SET.has(descriptor.value) &&
      SAFE_MODEL_ITEM_TYPE_SET.has(descriptor.value)
    ) {
      return { status: "safe" };
    }
  } catch {
    // Revoked proxies and descriptor traps are untrusted model events.
  }
  return { status: "breach", code: "TOOL_ISOLATION_BROKEN" };
}
import {
  authenticateModelIsolationAuthority,
  type ModelIsolationEnabledAuthority,
} from "./isolation-authority.js";
