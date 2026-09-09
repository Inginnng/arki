import { randomUUID } from "node:crypto";
import { posix, relative, sep, win32 } from "node:path";
import { pathToFileURL } from "node:url";

import {
  ContextBridge,
  ContextBridgeError,
  GENERATED_APP_SERVER_SCHEMA_VERSION,
  HostContextExtractor,
  createResolvedAppServerClient,
  resolveCodexExecutable,
  type TaskBindingResult,
  type TaskWorkspaceResolution,
  type UnverifiedBinding,
} from "@aimd/app-server-bridge";
import {
  OpaqueIdSchema,
  ReaderSessionSchema,
  type ReaderSession,
} from "@aimd/contracts";
import {
  createApprovalAuthority,
  type CreatedWorkspaceSnapshot,
} from "@aimd/reader-core";

import {
  canonicalPathKey,
  isCanonicalPathContained,
  sameCanonicalPath,
} from "./canonical-path.js";
import {
  getReaderStorageAuthority,
  loadReaderConfig,
  type ReaderConfigEnvironment,
} from "./config.js";
import {
  createModelSandboxLease,
  type ModelSandboxLease,
} from "./model-sandbox.js";
import type { ReaderMcpService } from "./mcp.js";
import { resolveWorkspaceRoot, type VerifiedWorkspaceRoot } from "./root-resolver.js";
import { createPackagedSafeOutputWriter } from "./safe-writer.js";
import {
  ReaderService,
  ReaderServiceError,
  type ReaderServiceBridge,
  type ReaderServiceWriter,
} from "./service.js";
import {
  openAnnotationRepository,
  type AnnotationStoreV1,
  type AnnotationRepository,
} from "./store.js";
import {
  openReadOnlyWorkspace,
  type ReadOnlyWorkspace,
} from "./workspace.js";

const MAX_PRODUCTION_ROOTS = 32;
const MAX_PRODUCTION_RUNTIMES = 64;
const MAX_SESSION_ROUTES = 4_096;
const MAX_RUN_ROUTES = 4_096;
const MAX_ANNOTATION_ROUTES = 4_096;
const MAX_PREVIEW_ROUTES = 8_192;

export type ProductionBridgeInput = Readonly<{
  canonicalRoot: string;
  rootBinding: VerifiedWorkspaceRoot;
  workspace: ReadOnlyWorkspace;
  workspaceSnapshot: CreatedWorkspaceSnapshot;
  workspaceLabel: string;
}>;

export type ProductionBridgeRuntime = Readonly<{
  bridge: ReaderServiceBridge;
  resolveTaskWorkspace?(binding: UnverifiedBinding): Promise<TaskWorkspaceResolution>;
  close(): Promise<void>;
}>;

export const PRODUCTION_APP_SERVER_SCHEMA_VERSION = GENERATED_APP_SERVER_SCHEMA_VERSION;

export type ProductionBridgeConnectorDependencies = Readonly<{
  resolveExecutable?: typeof resolveCodexExecutable;
  createClient?: typeof createResolvedAppServerClient;
  createSandboxLease?: typeof createModelSandboxLease;
}>;

export type ProductionReaderLimits = Readonly<{
  maxRuntimes?: number;
  maxSessionRoutes?: number;
  maxRunRoutes?: number;
  maxAnnotationRoutes?: number;
  maxPreviewRoutes?: number;
}>;

export type ProductionReaderServiceOptions = Readonly<{
  environment?: ReaderConfigEnvironment;
  userDataBaseDir?: string;
  connectBridge?: (input: ProductionBridgeInput) => Promise<ProductionBridgeRuntime>;
  writer?: ReaderServiceWriter;
  /** Internal host policy/test seam; never accepted from MCP or UI input. */
  limits?: ProductionReaderLimits;
  /** Internal deterministic concurrency seam; never accepted from MCP or UI input. */
  afterRunRouteReserved?: () => Promise<void>;
}>;

type RootRuntime = Readonly<{
  rootId: string;
  canonicalRoot: string;
  authorityRoot: string;
  workspace: ReadOnlyWorkspace;
  service: ReaderService;
  repository: AnnotationRepository;
  bridgeRuntime: ProductionBridgeRuntime;
  recoveredSessionIds: Set<string>;
}>;

type RootDescriptor = {
  readonly rootId: string;
  readonly canonicalRoot: string;
  readonly authorityRoot: string;
  readonly workspaceLabel: string;
  readonly resolution: Extract<Awaited<ReturnType<typeof resolveWorkspaceRoot>>, { status: "verified" }>;
  runtimePromise?: Promise<RootRuntime>;
  runtime?: RootRuntime;
};

type NormalizedLimits = Readonly<Required<ProductionReaderLimits>>;

function boundedLimit(value: number | undefined, fallback: number, hardMaximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) throw new ReaderServiceError("ROOT_NOT_FOUND");
  return Math.min(value, hardMaximum);
}

function normalizeLimits(limits: ProductionReaderLimits | undefined): NormalizedLimits {
  return {
    maxRuntimes: boundedLimit(limits?.maxRuntimes, MAX_PRODUCTION_RUNTIMES, MAX_PRODUCTION_RUNTIMES),
    maxSessionRoutes: boundedLimit(limits?.maxSessionRoutes, MAX_SESSION_ROUTES, MAX_SESSION_ROUTES),
    maxRunRoutes: boundedLimit(limits?.maxRunRoutes, MAX_RUN_ROUTES, MAX_RUN_ROUTES),
    maxAnnotationRoutes: boundedLimit(limits?.maxAnnotationRoutes, MAX_ANNOTATION_ROUTES, MAX_ANNOTATION_ROUTES),
    maxPreviewRoutes: boundedLimit(limits?.maxPreviewRoutes, MAX_PREVIEW_ROUTES, MAX_PREVIEW_ROUTES),
  };
}

function projectStoreRoot(state: AnnotationStoreV1, publicRootId: string): AnnotationStoreV1 {
  return {
    ...state,
    sessions: state.sessions.map((record) => ({
      ...record,
      value: ReaderSessionSchema.parse({ ...record.value, rootId: publicRootId }),
    })),
  };
}

/** Persisted storage is path-namespaced; public root ids are process-ephemeral. */
function projectRepositoryRoot(
  repository: AnnotationRepository,
  publicRootId: string,
): AnnotationRepository {
  return {
    persistenceStatus: repository.persistenceStatus,
    load: async () => projectStoreRoot(await repository.load(), publicRootId),
    save: async (value) => repository.save(value),
    upsertSession: async (value) => repository.upsertSession(value),
    getSession: async (id) => {
      const session = await repository.getSession(id);
      return session === undefined
        ? undefined
        : ReaderSessionSchema.parse({ ...session, rootId: publicRootId });
    },
    upsertAnnotation: async (value) => repository.upsertAnnotation(value),
    getAnnotation: async (id) => repository.getAnnotation(id),
    saveDraft: async (value) => repository.saveDraft(value),
    getDraft: async (id) => repository.getDraft(id),
    commitReviewedQuestion: async (value) => repository.commitReviewedQuestion(value),
    updateQuestionRun: async (id, value) => repository.updateQuestionRun(id, value),
    markStaleBySnapshot: async (digest) => repository.markStaleBySnapshot(digest),
    deleteSession: async (id) => repository.deleteSession(id),
    pruneBefore: async (recordsBefore, draftsBefore) => repository.pruneBefore(recordsBefore, draftsBefore),
  };
}

function issueId(scope: string): string {
  return OpaqueIdSchema.parse(`${scope}-${randomUUID()}`);
}

function workspaceLabel(canonicalRoot: string): string {
  return (process.platform === "win32" ? win32 : posix).basename(canonicalRoot) || "workspace";
}

function defaultPowerShellPath(): string {
  if (process.platform !== "win32") return "/usr/bin/false";
  const volume = win32.parse(process.execPath).root;
  if (!volume) return "powershell.exe";
  return win32.join(volume, "Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

function unavailableBridge(input: ProductionBridgeInput): ProductionBridgeRuntime {
  const bridge: ReaderServiceBridge = {
    async verifyBinding(): Promise<TaskBindingResult> {
      return { status: "unavailable", code: "TASK_CONTEXT_UNAVAILABLE" };
    },
    async createSession(
      binding: TaskBindingResult,
      _workspaceRoot: string,
      documentPath: string,
    ): Promise<ReaderSession> {
      return ReaderSessionSchema.parse({
        id: issueId("session"),
        bindingStatus: binding.status,
        contextMode: "project_only",
        rootId: input.workspaceSnapshot.publicSnapshot.rootId,
        workspaceLabel: input.workspaceLabel,
        documentPath,
        degradationReason: "Model execution unavailable; project documents remain readable",
      });
    },
    async *ask() {
      yield { type: "failed" as const, code: "MODEL_ISOLATION_UNPROVEN" as const };
    },
    async auditEvidence() {
      return { status: "failed" as const, code: "MODEL_ISOLATION_UNPROVEN" as const };
    },
    issueAcceptedSynthesisAnnotation() {
      throw new ContextBridgeError("MODEL_ISOLATION_UNPROVEN");
    },
    async synthesize() {
      return { status: "failed" as const, code: "MODEL_ISOLATION_UNPROVEN" as const };
    },
  };
  return {
    bridge,
    resolveTaskWorkspace: async () => ({ status: "unavailable" }),
    close: async () => undefined,
  };
}

async function connectProductionBridge(
  input: ProductionBridgeInput,
  dependencies: ProductionBridgeConnectorDependencies = {},
): Promise<ProductionBridgeRuntime> {
  let client: ReturnType<typeof createResolvedAppServerClient> | undefined;
  let sandbox: ModelSandboxLease | undefined;
  try {
    const resolution = await (dependencies.resolveExecutable ?? resolveCodexExecutable)({
      env: process.env,
      desktopVersion: GENERATED_APP_SERVER_SCHEMA_VERSION,
      untrustedRoots: [input.canonicalRoot],
    });
    if (resolution.status !== "resolved") return unavailableBridge(input);
    client = (dependencies.createClient ?? createResolvedAppServerClient)(resolution);
    sandbox = await (dependencies.createSandboxLease ?? createModelSandboxLease)(input.canonicalRoot);
    const bridge = new ContextBridge(client, {
      issueOpaqueId: () => issueId("bridge"),
      emptyCwd: sandbox.path,
      workspaceSnapshot: input.workspaceSnapshot,
      assertModelSandbox: () => sandbox!.assertTrustedEmpty(),
      captureWorkspaceDigest: async (plan) => {
        if (
          !sameCanonicalPath(plan.projectRoot, input.canonicalRoot) ||
          plan.rootId !== input.workspaceSnapshot.publicSnapshot.rootId
        ) throw new ContextBridgeError("WORKSPACE_AUTHORITY_INVALID");
        return (await input.workspace.snapshot({ relevantPaths: plan.relevantPaths })).snapshotDigest;
      },
    });
    let closePromise: Promise<void> | undefined;
    return {
      bridge,
      resolveTaskWorkspace: (binding) => bridge.resolveTaskWorkspace(binding),
      close: () => {
        closePromise ??= Promise.allSettled([client!.close(), sandbox!.close()]).then((results) => {
          if (results.some((result) => result.status === "rejected")) {
            throw new ContextBridgeError("APP_SERVER_RESTARTED");
          }
        });
        return closePromise;
      },
    };
  } catch {
    await Promise.allSettled([client?.close(), sandbox?.close()]);
    return unavailableBridge(input);
  }
}

/** Builds the production bridge path; dependencies are an internal deterministic test seam. */
export function createProductionBridgeConnector(
  dependencies: ProductionBridgeConnectorDependencies = {},
): (input: ProductionBridgeInput) => Promise<ProductionBridgeRuntime> {
  return async (input) => await connectProductionBridge(input, dependencies);
}

async function isAuthorizedRoot(
  canonicalRoot: string,
  roots: readonly { readonly uri: string }[],
): Promise<boolean> {
  for (const root of roots.slice(0, MAX_PRODUCTION_ROOTS)) {
    const resolution = await resolveWorkspaceRoot({ mcpRoots: [root] });
    if (
      resolution.status === "verified" &&
      isCanonicalPathContained(resolution.canonicalRoot, canonicalRoot)
    ) return true;
  }
  return false;
}

export class ProductionReaderService implements ReaderMcpService {
  readonly #extractor = new HostContextExtractor();
  readonly #options: ProductionReaderServiceOptions;
  readonly #writer: ReaderServiceWriter;
  readonly #limits: NormalizedLimits;
  readonly #descriptors = new Map<string, RootDescriptor>();
  readonly #rootsById = new Map<string, RootDescriptor>();
  readonly #sessions = new Map<string, RootRuntime>();
  readonly #runs = new Map<string, RootRuntime>();
  readonly #annotations = new Map<string, RootRuntime>();
  readonly #previews = new Map<string, RootRuntime>();
  readonly #pendingOperations = new Set<Promise<unknown>>();
  readonly #runtimeClosePromises = new WeakMap<RootRuntime, Promise<void>>();
  #runRouteTail: Promise<void> = Promise.resolve();
  #startingRuns = 0;
  #closed = false;
  #closePromise: Promise<void> | undefined;

  constructor(options: ProductionReaderServiceOptions = {}) {
    this.#options = options;
    this.#limits = normalizeLimits(options.limits);
    this.#writer = options.writer ?? createPackagedSafeOutputWriter({
      powershellExecutablePath: defaultPowerShellPath(),
    });
  }

  #track<T>(operation: Promise<T>): Promise<T> {
    this.#pendingOperations.add(operation);
    const remove = () => this.#pendingOperations.delete(operation);
    void operation.then(remove, remove);
    return operation;
  }

  #setBoundedRoute(
    routes: Map<string, RootRuntime>,
    id: string,
    runtime: RootRuntime,
    maximum: number,
  ): void {
    routes.delete(id);
    while (routes.size >= maximum) {
      routes.delete(routes.keys().next().value as string);
    }
    routes.set(id, runtime);
  }

  #deleteRuntimeRoutes(runtime: RootRuntime): void {
    for (const routes of [this.#sessions, this.#runs, this.#annotations, this.#previews]) {
      for (const [id, candidate] of routes) {
        if (candidate === runtime) routes.delete(id);
      }
    }
  }

  async #evictableRunRoute(): Promise<string | undefined> {
    for (const [id, runtime] of this.#runs) {
      try {
        const page = await runtime.service.pollQuestion(id);
        if (
          page.outcome === "events" &&
          page.events.some((event) => ["completed", "stale", "failed", "cancelled"].includes(event.type))
        ) return id;
      } catch (error) {
        if (error instanceof ReaderServiceError && error.code === "RUN_NOT_FOUND") return id;
      }
    }
    return undefined;
  }

  async #withRunRouteLock<T>(operation: () => Promise<T> | T): Promise<T> {
    const previous = this.#runRouteTail;
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.#runRouteTail = current;
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async #cacheRecoveredRunRoute(id: string, runtime: RootRuntime): Promise<void> {
    await this.#withRunRouteLock(async () => {
      this.#runs.delete(id);
      while (this.#runs.size + this.#startingRuns >= this.#limits.maxRunRoutes) {
        const terminal = await this.#evictableRunRoute();
        if (terminal === undefined) return;
        this.#runs.delete(terminal);
      }
      this.#runs.set(id, runtime);
    });
  }

  #closeRuntime(runtime: RootRuntime): Promise<void> {
    let pending = this.#runtimeClosePromises.get(runtime);
    if (!pending) {
      pending = (async () => {
        this.#deleteRuntimeRoutes(runtime);
        const serviceResult = await Promise.allSettled([runtime.service.close()]);
        const bridgeResult = await Promise.allSettled([runtime.bridgeRuntime.close()]);
        if ([...serviceResult, ...bridgeResult].some((result) => result.status === "rejected")) {
          throw new ReaderServiceError("SERVICE_CLOSED");
        }
      })();
      this.#runtimeClosePromises.set(runtime, pending);
    }
    return pending;
  }

  async #createRuntime(
    descriptor: RootDescriptor,
  ): Promise<RootRuntime> {
    const { resolution, authorityRoot } = descriptor;
    const canonicalRoot = resolution.canonicalRoot;
    const config = loadReaderConfig(this.#options.environment ?? process.env, {
      projectRoot: canonicalRoot,
      ...(this.#options.userDataBaseDir === undefined
        ? {}
        : { userDataBaseDir: this.#options.userDataBaseDir }),
    });
    const workspace = await openReadOnlyWorkspace(resolution.rootBinding, {
      denyGlobs: config.denyGlobs,
      rootId: descriptor.rootId,
    });
    const workspaceSnapshot = await workspace.snapshot({ relevantPaths: [] });
    const label = workspaceLabel(canonicalRoot);
    const bridgeRuntime = await (this.#options.connectBridge ?? connectProductionBridge)({
      canonicalRoot,
      rootBinding: resolution.rootBinding,
      workspace,
      workspaceSnapshot,
      workspaceLabel: label,
    });
    let runtime: RootRuntime | undefined;
    try {
      const storedRepository = await openAnnotationRepository(getReaderStorageAuthority(config), {
        retentionDays: config.retentionDays,
        draftRetentionDays: config.draftRetentionDays,
      });
      const rootId = descriptor.rootId;
      if (workspaceSnapshot.publicSnapshot.rootId !== rootId) {
        throw new ReaderServiceError("ROOT_NOT_FOUND");
      }
      const repository = projectRepositoryRoot(storedRepository, rootId);
      const service = new ReaderService({
        roots: [{
          rootId,
          workspaceLabel: label,
          canonicalRoot,
          workspace,
          listDocuments: () => workspace.listMarkdownDocuments(),
          requiresMcpRoot: true,
          authorizeMcpRoots: (roots) => isAuthorizedRoot(canonicalRoot, roots),
        }],
        repository,
        bridge: bridgeRuntime.bridge,
        approvalAuthority: createApprovalAuthority(),
        writer: this.#writer,
        captureTaskBinding: (requestMeta) => this.#extractor.extract(requestMeta),
        issueId,
      });
      runtime = {
        rootId,
        canonicalRoot,
        authorityRoot,
        workspace,
        service,
        repository,
        bridgeRuntime,
        recoveredSessionIds: new Set(),
      };
      await service.recoverInterruptedRuns();
      const state = await repository.load();
      for (const record of state.sessions) {
        runtime.recoveredSessionIds.add(record.value.id);
        this.#setBoundedRoute(
          this.#sessions,
          record.value.id,
          runtime,
          this.#limits.maxSessionRoutes,
        );
      }
      for (const record of state.drafts) {
        await this.#cacheRecoveredRunRoute(record.value.id, runtime);
      }
      for (const record of state.annotations) {
        this.#setBoundedRoute(
          this.#annotations,
          record.value.id,
          runtime,
          this.#limits.maxAnnotationRoutes,
        );
      }
      if (this.#closed) {
        await this.#closeRuntime(runtime).catch(() => undefined);
        throw new ReaderServiceError("SERVICE_CLOSED");
      }
      return runtime;
    } catch (error) {
      if (runtime) await this.#closeRuntime(runtime).catch(() => undefined);
      else await bridgeRuntime.close().catch(() => undefined);
      throw error;
    }
  }

  #descriptorForResolution(
    resolution: Extract<Awaited<ReturnType<typeof resolveWorkspaceRoot>>, { status: "verified" }>,
    authorityRoot: string,
  ): RootDescriptor | undefined {
    if (this.#closed) throw new ReaderServiceError("SERVICE_CLOSED");
    const authorityKey = canonicalPathKey(authorityRoot);
    const rootKey = canonicalPathKey(resolution.canonicalRoot);
    if (authorityKey === null || rootKey === null) return undefined;
    const key = JSON.stringify([authorityKey, rootKey]);
    let descriptor = this.#descriptors.get(key);
    if (!descriptor) {
      if (this.#descriptors.size >= this.#limits.maxRuntimes) return undefined;
      descriptor = {
        rootId: issueId("root"),
        canonicalRoot: resolution.canonicalRoot,
        authorityRoot,
        workspaceLabel: workspaceLabel(resolution.canonicalRoot),
        resolution,
      };
      this.#descriptors.set(key, descriptor);
      this.#rootsById.set(descriptor.rootId, descriptor);
    }
    return descriptor;
  }

  async #runtimeForDescriptor(descriptor: RootDescriptor): Promise<RootRuntime> {
    if (this.#closed) throw new ReaderServiceError("SERVICE_CLOSED");
    if (descriptor.runtime) return descriptor.runtime;
    if (!descriptor.runtimePromise) {
      const created = this.#createRuntime(descriptor).then((runtime) => {
        descriptor.runtime = runtime;
        return runtime;
      });
      descriptor.runtimePromise = created;
      void created.catch(() => {
        if (descriptor.runtimePromise === created) delete descriptor.runtimePromise;
      });
    }
    return await descriptor.runtimePromise;
  }

  async #closeDescriptor(descriptor: RootDescriptor): Promise<void> {
    const runtime = descriptor.runtime ?? await descriptor.runtimePromise?.catch(() => undefined);
    if (runtime) await this.#closeRuntime(runtime);
  }

  async #revokeMissingAuthorities(observed: ReadonlySet<string>): Promise<void> {
    const closing: Promise<unknown>[] = [];
    for (const [key, descriptor] of this.#descriptors) {
      const authorityKey = canonicalPathKey(descriptor.authorityRoot);
      if (authorityKey !== null && observed.has(authorityKey)) continue;
      this.#descriptors.delete(key);
      this.#rootsById.delete(descriptor.rootId);
      closing.push(this.#closeDescriptor(descriptor));
    }
    await Promise.allSettled(closing);
  }

  async #listRoots(mcpRoots?: readonly { readonly uri: string }[]): Promise<unknown> {
    if (!mcpRoots) {
      await this.#revokeMissingAuthorities(new Set());
      return [];
    }
    const resolutions = await Promise.allSettled(
      mcpRoots.slice(0, MAX_PRODUCTION_ROOTS).map((root) =>
        resolveWorkspaceRoot({ mcpRoots: [root] })),
    );
    if (this.#closed) throw new ReaderServiceError("SERVICE_CLOSED");
    const verified = resolutions.flatMap((result) =>
      result.status === "fulfilled" && result.value.status === "verified"
        ? [result.value]
        : [],
    );
    const observed = new Set(
      verified.flatMap((resolution) => {
        const key = canonicalPathKey(resolution.canonicalRoot);
        return key === null ? [] : [key];
      }),
    );
    await this.#revokeMissingAuthorities(observed);
    if (this.#closed) throw new ReaderServiceError("SERVICE_CLOSED");
    const descriptors = verified.map((resolution) =>
      this.#descriptorForResolution(resolution, resolution.canonicalRoot));
    if (this.#closed) throw new ReaderServiceError("SERVICE_CLOSED");
    const summaries = [];
    const seen = new Set<string>();
    for (const descriptor of descriptors) {
      if (!descriptor || seen.has(descriptor.rootId)) continue;
      seen.add(descriptor.rootId);
      summaries.push({
        rootId: descriptor.rootId,
        workspaceLabel: descriptor.workspaceLabel,
      });
    }
    return summaries;
  }

  async listRoots(mcpRoots?: readonly { readonly uri: string }[]): Promise<unknown> {
    if (this.#closed) throw new ReaderServiceError("SERVICE_CLOSED");
    return await this.#track(this.#listRoots(mcpRoots));
  }

  #root(rootId: string): RootDescriptor {
    const descriptor = this.#rootsById.get(OpaqueIdSchema.parse(rootId));
    if (!descriptor) throw new ReaderServiceError("ROOT_NOT_FOUND");
    return descriptor;
  }

  async #rootRuntime(rootId: string): Promise<RootRuntime> {
    return await this.#runtimeForDescriptor(this.#root(rootId));
  }

  async #session(sessionId: string): Promise<RootRuntime> {
    const id = OpaqueIdSchema.parse(sessionId);
    const routed = this.#sessions.get(id);
    if (routed) return routed;
    throw new ReaderServiceError("SESSION_NOT_FOUND");
  }

  async #run(runId: string): Promise<RootRuntime> {
    const id = OpaqueIdSchema.parse(runId);
    const routed = this.#runs.get(id);
    if (routed) return routed;
    throw new ReaderServiceError("RUN_NOT_FOUND");
  }

  async #annotation(annotationId: string): Promise<RootRuntime> {
    const id = OpaqueIdSchema.parse(annotationId);
    const routed = this.#annotations.get(id);
    if (routed) return routed;
    throw new ReaderServiceError("ANNOTATION_NOT_FOUND");
  }

  async listDocuments(rootId: string): Promise<unknown> {
    return await (await this.#rootRuntime(rootId)).service.listDocuments(rootId);
  }

  async openDocument(rootId: string, path: string): Promise<unknown> {
    return await (await this.#rootRuntime(rootId)).service.openDocument(rootId, path);
  }

  async readSource(rootId: string, path: string, startLine: number, endLine: number): Promise<unknown> {
    return await (await this.#rootRuntime(rootId)).service.readSource(rootId, path, startLine, endLine);
  }

  captureSessionBinding(requestMeta: unknown): UnverifiedBinding {
    if (this.#closed) throw new ReaderServiceError("SERVICE_CLOSED");
    return this.#extractor.extract(requestMeta);
  }

  async createSessionFromBinding(rootId: string, path: string, binding: unknown): Promise<unknown> {
    if (this.#closed) throw new ReaderServiceError("SERVICE_CLOSED");
    const operation = (async () => {
      const baseRuntime = await this.#rootRuntime(rootId);
      let runtime = baseRuntime;
      let documentPath = path;
      const taskWorkspace = await baseRuntime.bridgeRuntime.resolveTaskWorkspace?.(
        binding as UnverifiedBinding,
      ).catch(() => ({ status: "unavailable" as const }));
      if (taskWorkspace?.status === "resolved") {
        try {
          const document = await baseRuntime.workspace.guard.readFileBytes(path);
          const resolution = await resolveWorkspaceRoot({
            threadWorkspaceRoot: taskWorkspace.workspaceRoot,
            mcpRoots: [{ uri: pathToFileURL(baseRuntime.authorityRoot).href }],
            trustedHostDocumentPath: document.canonicalPath,
          });
          if (resolution.status === "verified" && resolution.contextMode === "task_and_project") {
            const narrowedDescriptor = this.#descriptorForResolution(
              resolution,
              baseRuntime.authorityRoot,
            );
            if (narrowedDescriptor) {
              const narrowed = await this.#runtimeForDescriptor(narrowedDescriptor);
              runtime = narrowed;
              documentPath = relative(runtime.canonicalRoot, document.canonicalPath)
                .split(sep)
                .join("/");
            }
          }
        } catch {
          // The original guarded root remains the only authority on any narrowing failure.
        }
      }
      const session = ReaderSessionSchema.parse(
        await runtime.service.createSessionFromBinding(
          runtime.rootId,
          documentPath,
          binding as UnverifiedBinding,
        ),
      );
      runtime.recoveredSessionIds.delete(session.id);
      this.#setBoundedRoute(this.#sessions, session.id, runtime, this.#limits.maxSessionRoutes);
      return session;
    })();
    return await this.#track(operation);
  }

  async authorizeAccess(
    reference: { readonly kind: "session" | "run" | "annotation" | "preview"; readonly id: string },
    mcpRoots?: readonly { readonly uri: string }[],
  ): Promise<void> {
    const runtime = reference.kind === "session"
      ? await this.#session(reference.id)
      : reference.kind === "run"
        ? await this.#run(reference.id)
        : reference.kind === "annotation"
          ? await this.#annotation(reference.id)
          : this.#previews.get(OpaqueIdSchema.parse(reference.id));
    if (!runtime) throw new ReaderServiceError("PATCH_NOT_FOUND");
    await runtime.service.authorizeAccess(reference, mcpRoots);
  }

  async startQuestion(sessionId: string, question: unknown): Promise<unknown> {
    if (this.#closed) throw new ReaderServiceError("SERVICE_CLOSED");
    return await this.#track(this.#startQuestion(sessionId, question));
  }

  async #startQuestion(sessionId: string, question: unknown): Promise<unknown> {
    const runtime = await this.#session(sessionId);
    if (runtime.recoveredSessionIds.has(sessionId)) {
      // A persisted reader session outlives its private App Server side thread.
      // Rebinding is required so exact task context is never silently fabricated.
      throw new ReaderServiceError("SERVER_RESTARTED");
    }
    await this.#withRunRouteLock(async () => {
      while (this.#runs.size + this.#startingRuns >= this.#limits.maxRunRoutes) {
        const terminal = await this.#evictableRunRoute();
        if (terminal === undefined) throw new ReaderServiceError("RUN_CAPACITY_EXCEEDED");
        this.#runs.delete(terminal);
      }
      this.#startingRuns += 1;
    });
    try {
      await this.#options.afterRunRouteReserved?.();
      const result = await runtime.service.startQuestion(sessionId, question);
      await this.#withRunRouteLock(() => {
        this.#runs.delete(result.runId);
        this.#runs.set(result.runId, runtime);
        this.#startingRuns -= 1;
      });
      return result;
    } catch (error) {
      await this.#withRunRouteLock(() => {
        this.#startingRuns -= 1;
      });
      throw error;
    }
  }

  async pollQuestion(runId: string, cursor?: unknown): Promise<unknown> {
    const runtime = await this.#run(runId);
    const result = await runtime.service.pollQuestion(runId, cursor as never);
    if (result.outcome === "events") {
      for (const event of result.events) {
        if (event.type !== "completed" && event.type !== "stale") continue;
        // ReaderService deliberately uses the opaque run id as the durable
        // annotation id; the answer DTO does not expose an extra routing id.
        if (event.payload.answer) {
          this.#setBoundedRoute(
            this.#annotations,
            runId,
            runtime,
            this.#limits.maxAnnotationRoutes,
          );
        }
      }
    }
    return result;
  }

  async cancelQuestion(runId: string): Promise<void> {
    const runtime = await this.#run(runId);
    await runtime.service.cancelQuestion(runId);
  }

  async setDisposition(annotationId: string, disposition: unknown): Promise<void> {
    const runtime = await this.#annotation(annotationId);
    await runtime.service.setDisposition(annotationId, disposition);
  }

  async preparePatch(sessionId: string, annotationIds: unknown): Promise<unknown> {
    const runtime = await this.#session(sessionId);
    const preview = await runtime.service.preparePatch(sessionId, annotationIds);
    this.#setBoundedRoute(this.#previews, preview.id, runtime, this.#limits.maxPreviewRoutes);
    return preview;
  }

  async approvePatch(sessionId: string, sourceHash: string, diffHash: string): Promise<unknown> {
    return await (await this.#session(sessionId)).service.approvePatch(sessionId, sourceHash, diffHash);
  }

  async writeExplained(sessionId: string, previewId: string, approvalToken: string): Promise<unknown> {
    const runtime = await this.#session(sessionId);
    if (this.#previews.get(previewId) !== runtime) throw new ReaderServiceError("PATCH_NOT_FOUND");
    return await runtime.service.writeExplained(sessionId, previewId, approvalToken);
  }

  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closed = true;
    this.#closePromise = (async () => {
      while (this.#pendingOperations.size > 0) {
        await Promise.allSettled([...this.#pendingOperations]);
      }
      const descriptors = [...this.#descriptors.values()];
      this.#descriptors.clear();
      this.#rootsById.clear();
      const closed = await Promise.allSettled(
        descriptors.map((descriptor) => this.#closeDescriptor(descriptor)),
      );
      if (closed.some((result) => result.status === "rejected")) {
        throw new ReaderServiceError("SERVICE_CLOSED");
      }
    })();
    return this.#closePromise;
  }
}

export function createProductionReaderService(
  options: ProductionReaderServiceOptions = {},
): ProductionReaderService {
  return new ProductionReaderService(options);
}
