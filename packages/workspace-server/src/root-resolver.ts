import { realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

import type { ContextMode } from "@aimd/contracts";

import { canonicalPathKey, isCanonicalPathContained as isContained } from "./canonical-path.js";

export type RootResolutionReason =
  | "WORKSPACE_ROOT_UNAVAILABLE"
  | "ROOT_MISMATCH"
  | "MCP_ROOT_REQUIRED"
  | "AMBIGUOUS_MCP_ROOT"
  | "ROOT_INPUT_LIMIT_EXCEEDED";

export interface WorkspaceRootIdentity {
  readonly device: string;
  readonly inode: string;
}

const VERIFIED_WORKSPACE_ROOT_BRAND: unique symbol = Symbol("aimd.verified-workspace-root");
const CONTROL_TREE_SEGMENTS = new Set([".git", ".hg", ".svn", ".aimd-git"]);
const CREDENTIAL_TREE_SEGMENT_PATTERNS = [
  /^\.env.*$/iu,
  /^\.(?:npmrc|pypirc|netrc)$/iu,
  /^credentials(?:\..*)?$/iu,
  /^id_(?:rsa|ed25519)(?:\..*)?$/iu,
  /\.(?:pem|key|p12|pfx)$/iu,
] as const;

export function isControlTreePath(value: string): boolean {
  return value.split(/[\\/]+/u).some((segment) => CONTROL_TREE_SEGMENTS.has(segment.toLowerCase()));
}

export function isCredentialTreePath(value: string): boolean {
  return value.split(/[\\/]+/u).some((segment) =>
    CREDENTIAL_TREE_SEGMENT_PATTERNS.some((pattern) => pattern.test(segment))
  );
}

export function isSensitiveTreePath(value: string): boolean {
  return isControlTreePath(value) || isCredentialTreePath(value);
}

/** Internal authority token captured at root resolution time. */
export interface VerifiedWorkspaceRoot {
  readonly canonicalRoot: string;
  readonly identity: WorkspaceRootIdentity;
  readonly [VERIFIED_WORKSPACE_ROOT_BRAND]: true;
}

function issueVerifiedWorkspaceRoot(
  canonicalRoot: string,
  identity: WorkspaceRootIdentity,
): VerifiedWorkspaceRoot {
  return Object.freeze({
    canonicalRoot,
    identity: Object.freeze(identity),
    [VERIFIED_WORKSPACE_ROOT_BRAND]: true as const,
  });
}

export function isVerifiedWorkspaceRoot(value: unknown): value is VerifiedWorkspaceRoot {
  return typeof value === "object" && value !== null &&
    (value as Record<PropertyKey, unknown>)[VERIFIED_WORKSPACE_ROOT_BRAND] === true;
}

export interface WorkspaceRootRequest {
  /** Workspace reported by an exact thread/read call. */
  threadWorkspaceRoot?: string | null;
  /** Undefined/null means roots/list is unavailable; an array means it was observed. */
  mcpRoots?: readonly (string | { readonly uri: string })[] | null;
  /** Adapter-only host metadata; never populate this from a public tool argument. */
  trustedHostDocumentPath?: string | null;
}

export type WorkspaceRootResolution =
  | {
      status: "verified";
      contextMode: Exclude<ContextMode, "document_only">;
      canonicalRoot: string;
      rootBinding: VerifiedWorkspaceRoot;
      source: "thread_read" | "mcp_roots";
      reason: null;
    }
  | {
      status: "degraded";
      contextMode: "document_only";
      canonicalRoot: null;
      source: null;
      reason: RootResolutionReason;
    };

export interface RootResolverDependencies {
  canonicalize(path: string): Promise<string>;
}

const DEFAULT_DEPENDENCIES: RootResolverDependencies = {
  canonicalize: realpath,
};
const MAX_MCP_ROOTS = 32;
const MAX_ROOT_INPUT_BYTES = 4_096;
const MAX_TOTAL_ROOT_INPUT_BYTES = 32 * 1_024;

function degraded(reason: RootResolutionReason): WorkspaceRootResolution {
  return {
    status: "degraded",
    contextMode: "document_only",
    canonicalRoot: null,
    source: null,
    reason,
  };
}

function comparisonKey(path: string): string {
  return canonicalPathKey(path) ?? path;
}

function inputBytes(value: unknown): number | null {
  if (typeof value === "string") return Buffer.byteLength(value, "utf8");
  if (
    typeof value === "object" && value !== null &&
    typeof (value as { readonly uri?: unknown }).uri === "string"
  ) return Buffer.byteLength((value as { readonly uri: string }).uri, "utf8");
  return null;
}

function exceedsInputBudget(request: WorkspaceRootRequest): boolean {
  const roots = request.mcpRoots;
  if (Array.isArray(roots) && roots.length > MAX_MCP_ROOTS) return true;
  const values: unknown[] = [request.threadWorkspaceRoot, request.trustedHostDocumentPath];
  if (Array.isArray(roots)) values.push(...roots);
  let total = 0;
  for (const value of values) {
    if (value === undefined || value === null) continue;
    const bytes = inputBytes(value);
    if (bytes === null || bytes > MAX_ROOT_INPUT_BYTES) return true;
    total += bytes;
    if (total > MAX_TOTAL_ROOT_INPUT_BYTES) return true;
  }
  return false;
}

async function canonicalizeOrNull(
  value: string | null | undefined,
  dependencies: RootResolverDependencies,
): Promise<VerifiedWorkspaceRoot | null> {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.includes("\0") ||
    !isAbsolute(value)
  ) return null;
  try {
    const canonical = await dependencies.canonicalize(value);
    if (!isAbsolute(canonical) || isSensitiveTreePath(canonical)) return null;
    const state = await stat(canonical, { bigint: true });
    if (!state.isDirectory()) return null;
    return issueVerifiedWorkspaceRoot(
      canonical,
      { device: state.dev.toString(), inode: state.ino.toString() },
    );
  } catch {
    return null;
  }
}

async function canonicalDocumentOrNull(
  value: string | null | undefined,
  dependencies: RootResolverDependencies,
): Promise<string | null> {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.includes("\0") ||
    !isAbsolute(value)
  ) return null;
  try {
    const canonical = await dependencies.canonicalize(value);
    if (!isAbsolute(canonical) || isSensitiveTreePath(canonical)) return null;
    const state = await stat(canonical);
    return state.isFile() ? canonical : null;
  } catch {
    return null;
  }
}

function mcpRootPath(value: string | { readonly uri: string }): string | null {
  if (typeof value === "string") {
    if (!/^file:/i.test(value)) return value;
    try {
      return fileURLToPath(value);
    } catch {
      return null;
    }
  }
  if (typeof value.uri !== "string" || !/^file:/i.test(value.uri)) return null;
  try {
    return fileURLToPath(value.uri);
  } catch {
    return null;
  }
}

async function canonicalMcpRoots(
  roots: readonly (string | { readonly uri: string })[],
  dependencies: RootResolverDependencies,
): Promise<VerifiedWorkspaceRoot[]> {
  const canonical = await Promise.all(
    roots.map((root) => canonicalizeOrNull(mcpRootPath(root), dependencies)),
  );
  const unique = new Map<string, VerifiedWorkspaceRoot>();
  for (const root of canonical) {
    if (root !== null) unique.set(comparisonKey(root.canonicalRoot), root);
  }
  return [...unique.values()];
}

/**
 * Resolves only host-authoritative roots. It deliberately has no cwd or
 * recent-thread fallback.
 */
export async function resolveWorkspaceRoot(
  request: WorkspaceRootRequest,
  dependencies: RootResolverDependencies = DEFAULT_DEPENDENCIES,
): Promise<WorkspaceRootResolution> {
  if (exceedsInputBudget(request)) return degraded("ROOT_INPUT_LIMIT_EXCEEDED");
  const hasThreadRoot = request.threadWorkspaceRoot !== undefined && request.threadWorkspaceRoot !== null;
  const hasObservedMcpRoots = Array.isArray(request.mcpRoots);
  const hasTrustedHostDocument = request.trustedHostDocumentPath !== undefined &&
    request.trustedHostDocumentPath !== null;
  const threadRoot = hasThreadRoot
    ? await canonicalizeOrNull(request.threadWorkspaceRoot, dependencies)
    : null;
  const document = hasTrustedHostDocument
    ? await canonicalDocumentOrNull(request.trustedHostDocumentPath, dependencies)
    : null;

  if (hasThreadRoot && threadRoot === null) return degraded("WORKSPACE_ROOT_UNAVAILABLE");

  if (threadRoot !== null) {
    if (hasObservedMcpRoots) {
      const roots = await canonicalMcpRoots(request.mcpRoots ?? [], dependencies);
      if (!roots.some((root) => isContained(root.canonicalRoot, threadRoot.canonicalRoot))) {
        return degraded("ROOT_MISMATCH");
      }
    }
    if (hasTrustedHostDocument && (
      document === null || !isContained(threadRoot.canonicalRoot, document)
    )) {
      return degraded("ROOT_MISMATCH");
    }
    return {
      status: "verified",
      contextMode: "task_and_project",
      canonicalRoot: threadRoot.canonicalRoot,
      rootBinding: threadRoot,
      source: "thread_read",
      reason: null,
    };
  }

  if (!hasObservedMcpRoots) return degraded("WORKSPACE_ROOT_UNAVAILABLE");
  const roots = await canonicalMcpRoots(request.mcpRoots ?? [], dependencies);
  if (roots.length === 0) return degraded("MCP_ROOT_REQUIRED");
  if (roots.length === 1) {
    if (hasTrustedHostDocument && (
      document === null || !isContained(roots[0]!.canonicalRoot, document)
    )) {
      return degraded("ROOT_MISMATCH");
    }
    return {
      status: "verified",
      contextMode: "project_only",
      canonicalRoot: roots[0]!.canonicalRoot,
      rootBinding: roots[0]!,
      source: "mcp_roots",
      reason: null,
    };
  }

  if (hasTrustedHostDocument && document === null) return degraded("ROOT_MISMATCH");
  if (document === null) return degraded("AMBIGUOUS_MCP_ROOT");
  const containingRoots = roots.filter((root) => isContained(root.canonicalRoot, document));
  if (containingRoots.length !== 1) return degraded("AMBIGUOUS_MCP_ROOT");
  return {
    status: "verified",
    contextMode: "project_only",
    canonicalRoot: containingRoots[0]!.canonicalRoot,
    rootBinding: containingRoots[0]!,
    source: "mcp_roots",
    reason: null,
  };
}
