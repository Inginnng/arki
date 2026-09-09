import { randomUUID } from "node:crypto";

const OPAQUE_BINDING_ID = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,159}$/;

export type UnverifiedBinding =
  | {
      status: "candidate";
      parentThreadId: string;
      parentTurnId?: string;
      source: "codex-hidden-meta";
    }
  | { status: "unavailable" };

export type HostContextCandidate = Extract<UnverifiedBinding, { status: "candidate" }>;

export type PublicBindingHandle = { bindingId: string };

type CandidateFields = {
  parentThreadId: string;
  parentTurnId?: string;
};

type OwnDataProperty =
  | { status: "absent" }
  | { status: "data"; value: unknown }
  | { status: "invalid" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function ownDataProperty(record: Record<string, unknown>, key: string): OwnDataProperty {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (!descriptor) return { status: "absent" };
  if (!Object.prototype.hasOwnProperty.call(descriptor, "value")) {
    return { status: "invalid" };
  }
  return { status: "data", value: descriptor.value };
}

function readHostId(value: unknown): string | undefined {
  return typeof value === "string" && OPAQUE_BINDING_ID.test(value) ? value : undefined;
}

function candidateFromProperties(
  thread: OwnDataProperty,
  turn: OwnDataProperty,
): CandidateFields | undefined {
  if (thread.status !== "data" || turn.status === "invalid") return undefined;
  const parentThreadId = readHostId(thread.value);
  if (!parentThreadId) return undefined;
  if (turn.status === "absent") return { parentThreadId };
  const parentTurnId = readHostId(turn.value);
  if (!parentTurnId) return undefined;
  return parentTurnId ? { parentThreadId, parentTurnId } : { parentThreadId };
}

function nestedCandidate(nested: unknown): CandidateFields | undefined {
  if (!isRecord(nested)) return undefined;
  return candidateFromProperties(
    ownDataProperty(nested, "thread_id"),
    ownDataProperty(nested, "turn_id"),
  );
}

function structuredCandidate(
  threadProperty: OwnDataProperty,
  turnProperty: OwnDataProperty,
): CandidateFields | undefined {
  if (threadProperty.status !== "data" || !isRecord(threadProperty.value)) return undefined;
  const threadId = ownDataProperty(threadProperty.value, "id");
  if (turnProperty.status === "invalid") return undefined;
  if (turnProperty.status === "absent") {
    return candidateFromProperties(threadId, { status: "absent" });
  }
  if (!isRecord(turnProperty.value)) return undefined;
  return candidateFromProperties(threadId, ownDataProperty(turnProperty.value, "id"));
}

/**
 * This is the only boundary that understands undocumented first-party
 * CallTool `_meta`. It reads exact allowlisted paths and never walks the input.
 */
export function extractUnverifiedBinding(rawMeta: unknown): UnverifiedBinding {
  try {
    if (!isRecord(rawMeta)) return { status: "unavailable" };

    const directThread = ownDataProperty(rawMeta, "openai/threadId");
    const directTurn = ownDataProperty(rawMeta, "openai/turnId");
    const nested = ownDataProperty(rawMeta, "x-codex-turn-metadata");
    const structuredThread = ownDataProperty(rawMeta, "thread");
    const structuredTurn = ownDataProperty(rawMeta, "turn");
    const candidates: CandidateFields[] = [];

    if (directThread.status !== "absent" || directTurn.status !== "absent") {
      const candidate = candidateFromProperties(directThread, directTurn);
      if (!candidate) return { status: "unavailable" };
      candidates.push(candidate);
    }
    if (nested.status !== "absent") {
      if (nested.status !== "data") return { status: "unavailable" };
      const candidate = nestedCandidate(nested.value);
      if (!candidate) return { status: "unavailable" };
      candidates.push(candidate);
    }
    if (structuredThread.status !== "absent" || structuredTurn.status !== "absent") {
      const candidate = structuredCandidate(structuredThread, structuredTurn);
      if (!candidate) return { status: "unavailable" };
      candidates.push(candidate);
    }

    if (candidates.length === 0) return { status: "unavailable" };
    const threadIds = new Set(candidates.map((candidate) => candidate.parentThreadId));
    const turnIds = new Set(
      candidates.flatMap((candidate) =>
        candidate.parentTurnId ? [candidate.parentTurnId] : [],
      ),
    );
    if (threadIds.size !== 1 || turnIds.size > 1) return { status: "unavailable" };

    const parentThreadId = candidates[0]?.parentThreadId;
    if (!parentThreadId) return { status: "unavailable" };
    const parentTurnId = [...turnIds][0];
    return parentTurnId
      ? {
          status: "candidate",
          parentThreadId,
          parentTurnId,
          source: "codex-hidden-meta",
        }
      : { status: "candidate", parentThreadId, source: "codex-hidden-meta" };
  } catch {
    return { status: "unavailable" };
  }
}

export class HostContextExtractor {
  extract(rawMeta: unknown): UnverifiedBinding {
    return extractUnverifiedBinding(rawMeta);
  }
}

export function createPublicBindingHandle(
  _candidate: HostContextCandidate,
  issueOpaqueId: () => string = () => `binding-${randomUUID()}`,
): PublicBindingHandle {
  const bindingId = issueOpaqueId();
  if (!OPAQUE_BINDING_ID.test(bindingId)) {
    throw new Error("OPAQUE_BINDING_ID_INVALID");
  }
  return { bindingId };
}
