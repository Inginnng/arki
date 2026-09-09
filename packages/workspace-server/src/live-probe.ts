import { randomUUID } from "node:crypto";

import {
  ContextBridge,
  GENERATED_APP_SERVER_SCHEMA_VERSION,
  HostContextExtractor,
  createPublicBindingHandle,
  createResolvedAppServerClient,
  resolveCodexExecutable,
  type AppServerThread,
  type BridgeAppServerClient,
  type ExecutableResolution,
  type HostContextCandidate,
  type TaskBindingResult,
} from "@aimd/app-server-bridge";
import type { ReaderSession } from "@aimd/contracts";
import {
  sha256Text,
  type WorkspaceSnapshotRecapturePlan,
} from "@aimd/reader-core";

import {
  CapabilityProbeReportSchema,
  PROBE_SOURCE_TEXT,
  PROBE_SOURCE_URI,
  deriveCapabilityFeatureFlags,
  type CapabilityProbeReport,
  type ProbeOutcome,
} from "./probe-contract.js";
import {
  ProbeBindingContextSchema,
  type ProbeBindingContext,
  type ProbeUiObservation,
  type RawHostRequestMetadata,
} from "./mcp.js";
import { createPathGuard } from "./path-guard.js";
import {
  createModelSandboxLease,
  type ModelSandboxLease,
} from "./model-sandbox.js";
import {
  resolveWorkspaceRoot,
  type WorkspaceRootResolution,
} from "./root-resolver.js";
import { openReadOnlyWorkspace } from "./workspace.js";

type ResolvedExecutable = Extract<ExecutableResolution, { status: "resolved" }>;
type LiveProbeClient = BridgeAppServerClient & { close?: () => Promise<void> };
type VerifiedWorkspaceRootResolution = Extract<
  WorkspaceRootResolution,
  { status: "verified" }
>;

export interface ProductionLiveProbeDependencies {
  readonly getMcpRoots: () => Promise<
    readonly (string | { readonly uri: string })[] | undefined
  >;
  readonly resolveExecutable: () => Promise<ExecutableResolution>;
  readonly createClient: (resolution: ResolvedExecutable) => LiveProbeClient;
  readonly createModelSandboxLease: (canonicalWorkspaceRoot: string) => Promise<ModelSandboxLease>;
  readonly issueOpaqueId: () => string;
}

export type ProductionLiveProbeOptions = Pick<
  ProductionLiveProbeDependencies,
  "getMcpRoots"
> & Partial<Omit<ProductionLiveProbeDependencies, "getMcpRoots">>;

export type ProductionLiveProbe = {
  /** The only synchronous boundary allowed to observe raw CallTool metadata. */
  readonly captureHostContext: (
    rawHostMetadata: RawHostRequestMetadata | undefined,
  ) => ProbeBindingContext;
  /** Receives only an opaque one-use token or an unavailable marker. */
  readonly runProbe: (
    binding: ProbeBindingContext,
    observation: ProbeUiObservation,
  ) => Promise<CapabilityProbeReport>;
  /** Idempotently closes every active App Server client and rejects new work. */
  readonly close: () => Promise<void>;
};

export class LiveProbeShutdownError extends Error {
  readonly code = "APP_SERVER_CLOSE_FAILED";

  constructor() {
    super("APP_SERVER_CLOSE_FAILED");
    this.name = "LiveProbeShutdownError";
  }
}

type BindingSummary =
  | "Exact task binding was verified."
  | "Exact task binding could not be verified."
  | "The App Server capability was unavailable."
  | "Live task metadata is required.";
type ForkSummary =
  | "An exact ephemeral fork was verified."
  | "The exact ephemeral fork could not be verified."
  | "Ephemeral fork creation was not evaluated.";

type GateInput = {
  readonly binding: {
    readonly status: ProbeOutcome;
    readonly summary: BindingSummary;
    readonly diagnosticCode?:
      | "HOST_CAPABILITY_UNAVAILABLE"
      | "TASK_BINDING_UNAVAILABLE";
  };
  readonly fork: {
    readonly status: ProbeOutcome;
    readonly summary: ForkSummary;
    readonly diagnosticCode?: "EPHEMERAL_FORK_UNAVAILABLE";
  };
  readonly fidelityStatus?: "not_run" | "failed";
};

const MAX_PENDING_BINDINGS = 32;
const PROBE_DOCUMENT_PATH = "README.md";

function createReport(input: GateInput): CapabilityProbeReport {
  const fidelityStatus = input.fidelityStatus ?? "not_run";
  const gates = [
    {
      id: "P0-A" as const,
      status: "inconclusive" as const,
      summary: "The resource challenge completed, but host UI provenance was not attested." as const,
      diagnosticCode: "UI_PROVENANCE_UNATTESTED" as const,
    },
    { id: "P0-B" as const, ...input.binding },
    { id: "P0-C" as const, ...input.fork },
    {
      id: "P0-D" as const,
      status: fidelityStatus,
      summary: fidelityStatus === "failed"
        ? "Context fidelity checks failed safely." as const
        : "Context fidelity was not evaluated." as const,
      diagnosticCode: "CONTEXT_FIDELITY_UNVERIFIED" as const,
    },
    {
      id: "P0-E" as const,
      status: "not_run" as const,
      summary: "The complete failure matrix was not run by this entry point." as const,
      diagnosticCode: "FAILURE_MATRIX_INCOMPLETE" as const,
    },
  ];
  return CapabilityProbeReportSchema.parse({
    reportVersion: 1,
    gates,
    featureFlags: deriveCapabilityFeatureFlags(gates),
    sourcePeek: {
      uri: PROBE_SOURCE_URI,
      excerptHash: sha256Text(PROBE_SOURCE_TEXT),
    },
  });
}

function unverifiedUiReport(): CapabilityProbeReport {
  const gates = [
    {
      id: "P0-A" as const,
      status: "failed" as const,
      summary: "The capability probe failed at its trusted server boundary." as const,
      diagnosticCode: "PROBE_INTERNAL_FAILURE" as const,
    },
    { id: "P0-B" as const, status: "not_run" as const, summary: "Exact task binding was not evaluated." as const },
    { id: "P0-C" as const, status: "not_run" as const, summary: "Ephemeral fork creation was not evaluated." as const },
    { id: "P0-D" as const, status: "not_run" as const, summary: "Context fidelity was not evaluated." as const },
    {
      id: "P0-E" as const,
      status: "not_run" as const,
      summary: "The complete failure matrix was not run by this entry point." as const,
      diagnosticCode: "FAILURE_MATRIX_INCOMPLETE" as const,
    },
  ];
  return CapabilityProbeReportSchema.parse({
    reportVersion: 1,
    gates,
    featureFlags: deriveCapabilityFeatureFlags(gates),
    sourcePeek: {
      uri: PROBE_SOURCE_URI,
      excerptHash: sha256Text(PROBE_SOURCE_TEXT),
    },
  });
}

function unboundReport(
  status: "failed" | "unsupported" = "unsupported",
  diagnosticCode: "HOST_CAPABILITY_UNAVAILABLE" | "TASK_BINDING_UNAVAILABLE" =
    "TASK_BINDING_UNAVAILABLE",
): CapabilityProbeReport {
  const summary: BindingSummary = diagnosticCode === "HOST_CAPABILITY_UNAVAILABLE"
    ? "The App Server capability was unavailable."
    : status === "failed"
      ? "Exact task binding could not be verified."
      : "Live task metadata is required.";
  return createReport({
    binding: { status, summary, diagnosticCode },
    fork: {
      status: "not_run",
      summary: "Ephemeral fork creation was not evaluated.",
      diagnosticCode: "EPHEMERAL_FORK_UNAVAILABLE",
    },
  });
}

function exactBindingReport(
  forkStatus: "passed" | "failed",
  fidelityStatus: "not_run" | "failed" = "not_run",
): CapabilityProbeReport {
  return createReport({
    binding: { status: "passed", summary: "Exact task binding was verified." },
    fork: forkStatus === "passed"
      ? { status: "passed", summary: "An exact ephemeral fork was verified." }
      : {
          status: "failed",
          summary: "The exact ephemeral fork could not be verified.",
          diagnosticCode: "EPHEMERAL_FORK_UNAVAILABLE",
        },
    fidelityStatus,
  });
}

function exactBindingWithoutForkReport(): CapabilityProbeReport {
  return createReport({
    binding: { status: "passed", summary: "Exact task binding was verified." },
    fork: {
      status: "not_run",
      summary: "Ephemeral fork creation was not evaluated.",
      diagnosticCode: "EPHEMERAL_FORK_UNAVAILABLE",
    },
  });
}

function projectFallbackReport(
  fidelityStatus: "not_run" | "failed",
): CapabilityProbeReport {
  return createReport({
    binding: {
      status: "unsupported",
      summary: "Live task metadata is required.",
      diagnosticCode: "TASK_BINDING_UNAVAILABLE",
    },
    fork: {
      status: "not_run",
      summary: "Ephemeral fork creation was not evaluated.",
      diagnosticCode: "EPHEMERAL_FORK_UNAVAILABLE",
    },
    fidelityStatus,
  });
}

async function readMcpRoots(
  provider: ProductionLiveProbeDependencies["getMcpRoots"],
): Promise<
  | { readonly status: "available"; readonly roots: readonly (string | { readonly uri: string })[] }
  | { readonly status: "unavailable" }
  | { readonly status: "failed" }
> {
  try {
    const roots = await provider();
    return roots === undefined
      ? { status: "unavailable" }
      : { status: "available", roots };
  } catch {
    return { status: "failed" };
  }
}

async function isolationRemainsBlocked(
  bridge: ContextBridge,
  _session: ReaderSession,
): Promise<boolean> {
  const status = await bridge.modelExecutionStatus();
  return status.status === "reader_only" && status.code === "MODEL_ISOLATION_UNPROVEN";
}

async function closeClient(client: LiveProbeClient | undefined): Promise<void> {
  if (!client?.close) return;
  try {
    await client.close();
  } catch {
    throw new LiveProbeShutdownError();
  }
}

/**
 * Creates the restart-time production probe. It never accepts a public task id,
 * discovers a recent task, or treats process.cwd() as a project root.
 */
export function createProductionLiveProbe(
  options: ProductionLiveProbeOptions,
): ProductionLiveProbe {
  const extractor = new HostContextExtractor();
  const pendingBindings = new Map<string, HostContextCandidate>();
  const activeClients = new Set<LiveProbeClient>();
  const clientClosePromises = new WeakMap<LiveProbeClient, Promise<void>>();
  let closed = false;
  let closePromise: Promise<void> | undefined;
  const issueOpaqueId = options.issueOpaqueId ?? (() => `probe-${randomUUID()}`);
  const resolveExecutable = options.resolveExecutable ?? (() =>
    resolveCodexExecutable({
      env: process.env,
      desktopVersion: GENERATED_APP_SERVER_SCHEMA_VERSION,
    }));
  const createClient = options.createClient ?? ((resolution: ResolvedExecutable) =>
    createResolvedAppServerClient(resolution));
  const createSandboxLease = options.createModelSandboxLease ?? createModelSandboxLease;
  const activeSandboxLeases = new Set<ModelSandboxLease>();
  const pendingSandboxCreations = new Set<Promise<ModelSandboxLease>>();
  const sandboxClosePromises = new WeakMap<ModelSandboxLease, Promise<void>>();

  const captureHostContext = (
    rawHostMetadata: RawHostRequestMetadata | undefined,
  ): ProbeBindingContext => {
    if (closed) return { status: "unavailable" };
    const extracted = extractor.extract(rawHostMetadata);
    if (extracted.status !== "candidate") return { status: "unavailable" };
    const handle = createPublicBindingHandle(extracted, issueOpaqueId);
    if (pendingBindings.has(handle.bindingId)) throw new Error("OPAQUE_BINDING_ID_REUSED");
    while (pendingBindings.size >= MAX_PENDING_BINDINGS) {
      const oldest = pendingBindings.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      pendingBindings.delete(oldest);
    }
    pendingBindings.set(handle.bindingId, extracted);
    return ProbeBindingContextSchema.parse({
      status: "candidate",
      bindingToken: handle.bindingId,
    });
  };

  const closeTrackedClient = (client: LiveProbeClient): Promise<void> => {
    let current = clientClosePromises.get(client);
    if (!current) {
      current = closeClient(client);
      clientClosePromises.set(client, current);
    }
    return current;
  };

  const closeTrackedSandbox = (lease: ModelSandboxLease): Promise<void> => {
    let current = sandboxClosePromises.get(lease);
    if (!current) {
      current = lease.close().catch(() => {
        throw new LiveProbeShutdownError();
      });
      sandboxClosePromises.set(lease, current);
    }
    return current;
  };

  const createTrackedSandbox = (canonicalRoot: string): Promise<ModelSandboxLease> => {
    if (closed) return Promise.reject(new LiveProbeShutdownError());
    let tracked!: Promise<ModelSandboxLease>;
    tracked = Promise.resolve()
      .then(() => createSandboxLease(canonicalRoot))
      .then((lease) => {
        activeSandboxLeases.add(lease);
        return lease;
      })
      .finally(() => {
        pendingSandboxCreations.delete(tracked);
      });
    pendingSandboxCreations.add(tracked);
    return tracked;
  };

  const close = (): Promise<void> => {
    if (closePromise) return closePromise;
    closed = true;
    pendingBindings.clear();
    closePromise = (async () => {
      // Close already-active clients immediately, but do not resolve shutdown
      // until every factory that was registered before `closed = true` has
      // either failed or published its lease into activeSandboxLeases.
      const initialClientClose = Promise.allSettled(
        [...activeClients].map((client) => closeTrackedClient(client)),
      );
      await Promise.allSettled([...pendingSandboxCreations]);
      const finalResults = await Promise.allSettled([
        ...[...activeClients].map((client) => closeTrackedClient(client)),
        ...[...activeSandboxLeases].map((lease) => closeTrackedSandbox(lease)),
      ]);
      const initialResults = await initialClientClose;
      if ([...initialResults, ...finalResults].some((result) => result.status === "rejected")) {
        throw new LiveProbeShutdownError();
      }
    })();
    return closePromise;
  };

  const runProbe = async (
    bindingInput: ProbeBindingContext,
    observation: ProbeUiObservation,
  ): Promise<CapabilityProbeReport> => {
    if (observation?.resourceChallengeCompleted !== true) return unverifiedUiReport();
    if (closed) return unboundReport("failed", "HOST_CAPABILITY_UNAVAILABLE");
    const binding = ProbeBindingContextSchema.parse(bindingInput);
    let candidate: HostContextCandidate | undefined;
    if (binding.status === "candidate") {
      candidate = pendingBindings.get(binding.bindingToken);
      // One-use deletion happens before the first await, including failures.
      pendingBindings.delete(binding.bindingToken);
      if (!candidate) return unboundReport("failed");
    }

    const mcpRootsResult = await readMcpRoots(options.getMcpRoots);
    if (closed) return unboundReport("failed", "HOST_CAPABILITY_UNAVAILABLE");
    if (mcpRootsResult.status === "failed") {
      return unboundReport("failed", "HOST_CAPABILITY_UNAVAILABLE");
    }
    const mcpRoots = mcpRootsResult.status === "available"
      ? mcpRootsResult.roots
      : undefined;
    let projectRoot: VerifiedWorkspaceRootResolution | undefined;
    if (!candidate) {
      if (mcpRoots === undefined) return unboundReport();
      let resolvedProjectRoot: WorkspaceRootResolution;
      try {
        resolvedProjectRoot = await resolveWorkspaceRoot({ mcpRoots });
      } catch {
        return unboundReport("failed", "HOST_CAPABILITY_UNAVAILABLE");
      }
      if (closed) return unboundReport("failed", "HOST_CAPABILITY_UNAVAILABLE");
      if (
        resolvedProjectRoot.status !== "verified" ||
        resolvedProjectRoot.contextMode !== "project_only"
      ) {
        return unboundReport();
      }
      projectRoot = resolvedProjectRoot;
    }
    let resolution: ExecutableResolution;
    try {
      resolution = await resolveExecutable();
    } catch {
      return unboundReport("failed", "HOST_CAPABILITY_UNAVAILABLE");
    }
    if (closed) return unboundReport("failed", "HOST_CAPABILITY_UNAVAILABLE");
    if (resolution.status !== "resolved") {
      return unboundReport("unsupported", "HOST_CAPABILITY_UNAVAILABLE");
    }

    let client: LiveProbeClient | undefined;
    let sandboxLease: ModelSandboxLease | undefined;
    try {
      client = createClient(resolution);
      activeClients.add(client);
      await client.initialize();

      const createBridge = async (
        root: VerifiedWorkspaceRootResolution,
      ): Promise<ContextBridge> => {
        sandboxLease = await createTrackedSandbox(root.canonicalRoot);
        if (closed) throw new LiveProbeShutdownError();
        const workspace = await openReadOnlyWorkspace(root.rootBinding);
        const workspaceSnapshot = await workspace.snapshot({ relevantPaths: [] });
        const captureWorkspaceDigest = async (
          plan: WorkspaceSnapshotRecapturePlan,
        ): Promise<string> => {
          if (
            plan.projectRoot !== root.canonicalRoot ||
            plan.rootId !== workspaceSnapshot.publicSnapshot.rootId
          ) {
            throw new Error("WORKSPACE_SNAPSHOT_ROOT_MISMATCH");
          }
          return (await workspace.snapshot({ relevantPaths: plan.relevantPaths })).snapshotDigest;
        };
        return new ContextBridge(client!, {
          issueOpaqueId,
          emptyCwd: sandboxLease.path,
          workspaceSnapshot,
          assertModelSandbox: () => sandboxLease!.assertTrustedEmpty(),
          captureWorkspaceDigest,
        });
      };

      if (candidate) {
        let observedThread: AppServerThread;
        try {
          observedThread = await client.readThread(candidate.parentThreadId, true);
        } catch {
          return unboundReport("failed");
        }
        if (observedThread.id !== candidate.parentThreadId) return unboundReport("failed");

        const exactRoot = await resolveWorkspaceRoot({
          threadWorkspaceRoot: observedThread.cwd,
          ...(mcpRoots === undefined ? {} : { mcpRoots }),
        });
        if (exactRoot.status !== "verified" || exactRoot.contextMode !== "task_and_project") {
          return unboundReport("failed");
        }
        let rootGuard;
        try {
          rootGuard = await createPathGuard(exactRoot.rootBinding);
          await rootGuard.assertRootAuthority();
        } catch {
          return unboundReport("failed");
        }
        if (
          candidate.parentTurnId &&
          !observedThread.turns.some((turn) => turn.id === candidate.parentTurnId)
        ) {
          return unboundReport("failed");
        }
        if (!observedThread.turns.some((turn) => turn.status === "completed")) {
          try {
            await rootGuard.assertRootAuthority();
          } catch {
            return unboundReport("failed");
          }
          return exactBindingWithoutForkReport();
        }

        const bridge = await createBridge(exactRoot);
        const verified = await bridge.verifyBinding(candidate, exactRoot.canonicalRoot);
        try {
          await rootGuard.assertRootAuthority();
        } catch {
          return unboundReport("failed");
        }
        if (verified.status === "mismatch") return unboundReport("failed");
        if (verified.status !== "verified") return unboundReport("failed");

        let session: ReaderSession;
        try {
          await rootGuard.assertRootAuthority();
          session = await bridge.createSession(
            verified,
            exactRoot.canonicalRoot,
            PROBE_DOCUMENT_PATH,
          );
          await rootGuard.assertRootAuthority();
        } catch {
          return exactBindingReport("failed", "failed");
        }
        const blocked = await isolationRemainsBlocked(bridge, session);
        try {
          await rootGuard.assertRootAuthority();
        } catch {
          return unboundReport("failed");
        }
        return exactBindingReport("passed", blocked ? "not_run" : "failed");
      }

      if (!projectRoot) {
        return unboundReport("failed", "HOST_CAPABILITY_UNAVAILABLE");
      }
      let bridge: ContextBridge;
      try {
        bridge = await createBridge(projectRoot);
      } catch {
        return projectFallbackReport("failed");
      }
      return await runProjectFallback(bridge, projectRoot);
    } catch {
      return unboundReport("failed", "HOST_CAPABILITY_UNAVAILABLE");
    } finally {
      if (client) {
        const closeResults = await Promise.allSettled([
          closeTrackedClient(client),
          ...(sandboxLease ? [closeTrackedSandbox(sandboxLease)] : []),
        ]);
        if (closeResults[0]?.status === "fulfilled") activeClients.delete(client);
        if (sandboxLease && closeResults[1]?.status === "fulfilled") {
          activeSandboxLeases.delete(sandboxLease);
        }
        if (closeResults.some((result) => result.status === "rejected")) {
          throw new LiveProbeShutdownError();
        }
      }
    }
  };

  return { captureHostContext, runProbe, close };
}

async function runProjectFallback(
  bridge: ContextBridge,
  projectRoot: VerifiedWorkspaceRootResolution,
): Promise<CapabilityProbeReport> {
  let rootGuard;
  try {
    rootGuard = await createPathGuard(projectRoot.rootBinding);
    await rootGuard.assertRootAuthority();
  } catch {
    return projectFallbackReport("failed");
  }

  const binding: TaskBindingResult = {
    status: "unavailable",
    code: "TASK_CONTEXT_UNAVAILABLE",
  };
  let session: ReaderSession;
  try {
    await rootGuard.assertRootAuthority();
    session = await bridge.createSession(
      binding,
      projectRoot.canonicalRoot,
      PROBE_DOCUMENT_PATH,
    );
    await rootGuard.assertRootAuthority();
  } catch {
    return projectFallbackReport("failed");
  }
  const blocked = await isolationRemainsBlocked(bridge, session);
  try {
    await rootGuard.assertRootAuthority();
  } catch {
    return projectFallbackReport("failed");
  }
  return projectFallbackReport(blocked ? "not_run" : "failed");
}
