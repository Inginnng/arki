import type { ExecutableResolution } from "./executable.js";
import {
  GENERATED_APP_SERVER_SCHEMA_VERSION,
  type GeneratedInitializeParamsAdapter,
  type GeneratedThreadAdapter,
  type GeneratedThreadForkParamsAdapter,
  type GeneratedThreadReadParamsAdapter,
  type GeneratedTurnAdapter,
  type GeneratedTurnInterruptParamsAdapter,
} from "./generated-protocol.js";
import {
  JsonlRpcClient,
  spawnStdioJsonlTransport,
  type StructuredDiagnostic,
} from "./jsonl.js";
import {
  evaluateModelIsolationCapability,
  type ModelIsolationResult,
} from "./isolation.js";
import {
  buildAppServerLaunchArguments,
  buildReadOnlyThreadStartParams,
  buildReadOnlyTurnStartParams,
} from "./policy.js";

export type AppServerNotification = { method: string; params?: unknown };

export interface AppServerRpcConnection {
  request(
    method: string,
    params: unknown,
    options?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<unknown>;
  notify(method: string, params?: unknown): void;
  onNotification(listener: (notification: AppServerNotification) => void): () => void;
  onFailure(listener: (error: { readonly code: string }) => void): () => void;
  close(): Promise<void>;
}

type ResolvedExecutable = Extract<ExecutableResolution, { status: "resolved" }>;

export function createResolvedAppServerClient(
  resolution: ResolvedExecutable,
  dependencies: {
    connect?: (executablePath: string, args: readonly string[]) => AppServerRpcConnection;
    onDiagnostic?: (diagnostic: StructuredDiagnostic) => void;
  } = {},
): AppServerClient {
  const exactContextExecutable =
    resolution.exactContextEligible === true &&
    (
      (
        resolution.source === "environment" &&
        resolution.trust === "operator_explicit"
      ) ||
      (
        resolution.source === "verified_host_hint" &&
        resolution.trust === "verified_host"
      )
    );
  if (!exactContextExecutable) {
    throw new AppServerClientError("APP_SERVER_EXECUTABLE_UNTRUSTED");
  }
  if (resolution.version !== GENERATED_APP_SERVER_SCHEMA_VERSION) {
    throw new AppServerClientError("APP_SERVER_SCHEMA_VERSION_MISMATCH");
  }
  const args = buildAppServerLaunchArguments();
  const connection = dependencies.connect
    ? dependencies.connect(resolution.executablePath, args)
    : new JsonlRpcClient(
        spawnStdioJsonlTransport(resolution.executablePath, args),
        dependencies.onDiagnostic
          ? { onDiagnostic: dependencies.onDiagnostic }
          : {},
      );
  return new AppServerClient(connection, {
    expectedVersion: GENERATED_APP_SERVER_SCHEMA_VERSION,
  });
}

export type AppServerTurn = GeneratedTurnAdapter;

export type AppServerThread = GeneratedThreadAdapter & { internalIds?: string[] };

export type AppServerEvent =
  | { type: "started"; turnId: string }
  | { type: "text_delta"; text: string }
  | { type: "item"; phase: "started" | "completed"; item: unknown }
  | { type: "completed"; turn: AppServerTurn }
  | { type: "cancelled" };

export class AppServerClientError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "AppServerClientError";
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function collectProtocolInternalIds(value: unknown): string[] {
  const ids = new Set<string>();
  const visit = (current: unknown): void => {
    if (Array.isArray(current)) {
      for (const item of current) visit(item);
      return;
    }
    if (!isRecord(current)) return;
    for (const [key, item] of Object.entries(current)) {
      if (
        typeof item === "string" &&
        (key === "id" || /(?:Id|_id)$/u.test(key)) &&
        item.length > 0
      ) {
        ids.add(item);
      } else if (
        Array.isArray(item) &&
        /(?:Ids|_ids)$/u.test(key)
      ) {
        for (const id of item) {
          if (typeof id === "string" && id.length > 0) ids.add(id);
        }
      }
      visit(item);
    }
  };
  visit(value);
  return [...ids];
}

function userAgentVersion(userAgent: string): string | undefined {
  return /^codex-cli\/([0-9A-Za-z][0-9A-Za-z.+-]{0,63})$/u.exec(userAgent)?.[1];
}

function parseTurn(value: unknown): AppServerTurn {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    !["completed", "interrupted", "failed", "inProgress"].includes(String(value.status)) ||
    !Array.isArray(value.items)
  ) {
    throw new AppServerClientError("APP_SERVER_TURN_INVALID");
  }
  const startedAt = typeof value.startedAt === "number" ? value.startedAt : null;
  const completedAt = typeof value.completedAt === "number" ? value.completedAt : null;
  return {
    id: value.id,
    status: value.status as AppServerTurn["status"],
    items: value.items,
    startedAt,
    completedAt,
  };
}

function isGeneratedThreadStatus(value: unknown): value is { type: string } {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  if (value.type === "active") {
    return (
      Array.isArray(value.activeFlags) &&
      value.activeFlags.every(
        (flag) => flag === "waitingOnApproval" || flag === "waitingOnUserInput",
      )
    );
  }
  return value.type === "notLoaded" || value.type === "idle" || value.type === "systemError";
}

function parseThread(value: unknown): AppServerThread {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.cwd !== "string" ||
    typeof value.ephemeral !== "boolean" ||
    !(typeof value.forkedFromId === "string" || value.forkedFromId === null) ||
    !isGeneratedThreadStatus(value.status) ||
    !Array.isArray(value.turns)
  ) {
    throw new AppServerClientError("APP_SERVER_THREAD_INVALID");
  }
  let turns: AppServerTurn[];
  try {
    turns = value.turns.map(parseTurn);
  } catch {
    throw new AppServerClientError("APP_SERVER_THREAD_INVALID");
  }
  return {
    id: value.id,
    cwd: value.cwd,
    ephemeral: value.ephemeral,
    forkedFromId: value.forkedFromId,
    status: { type: value.status.type },
    turns,
    internalIds: collectProtocolInternalIds(value),
  };
}

function parseThreadResponse(value: unknown): AppServerThread {
  if (!isRecord(value) || !("thread" in value)) {
    throw new AppServerClientError("APP_SERVER_THREAD_INVALID");
  }
  return parseThread(value.thread);
}

class AsyncEventQueue<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<{
    resolve(value: IteratorResult<T>): void;
    reject(reason: AppServerClientError): void;
  }> = [];
  private failure?: AppServerClientError;
  private ended = false;

  push(value: T): void {
    if (this.ended) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve({ value, done: false });
    else this.values.push(value);
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter.resolve({ value: undefined, done: true });
    }
  }

  fail(reason: AppServerClientError): void {
    if (this.ended) return;
    this.ended = true;
    this.failure = reason;
    this.values.splice(0);
    for (const waiter of this.waiters.splice(0)) waiter.reject(reason);
  }

  next(): Promise<IteratorResult<T>> {
    const value = this.values.shift();
    if (value !== undefined) return Promise.resolve({ value, done: false });
    if (this.failure) return Promise.reject(this.failure);
    if (this.ended) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }
}

export class AppServerClient {
  private initializePromise?: Promise<{
    userAgent: string;
    platformFamily: string;
    platformOs: string;
  }>;
  private closePromise?: Promise<void>;

  constructor(
    private readonly rpc: AppServerRpcConnection,
    private readonly options: { expectedVersion?: string } = {},
  ) {}

  modelIsolationResult(): ModelIsolationResult {
    return evaluateModelIsolationCapability(undefined);
  }

  private async requestWithTimeout(
    method: string,
    params: unknown,
    timeoutMs: number,
    timeoutCode: string,
  ): Promise<unknown> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.rpc.request(method, params, { timeoutMs }),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => {
            void this.closeConnectionOnce().catch(() => undefined);
            reject(new AppServerClientError(timeoutCode));
          }, timeoutMs);
        }),
      ]);
    } catch (error) {
      if (isRecord(error) && error.code === "APP_SERVER_TIMEOUT") {
        void this.closeConnectionOnce().catch(() => undefined);
        throw new AppServerClientError(timeoutCode);
      }
      throw error;
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private closeConnectionOnce(): Promise<void> {
    if (!this.closePromise) {
      try {
        this.closePromise = this.rpc.close().catch((error) => {
          throw new AppServerClientError(
            isRecord(error) && error.code === "APP_SERVER_CLOSE_TIMEOUT"
              ? "APP_SERVER_CLOSE_TIMEOUT"
              : "APP_SERVER_CLOSE_FAILED",
          );
        });
      } catch {
        this.closePromise = Promise.reject(
          new AppServerClientError("APP_SERVER_CLOSE_FAILED"),
        );
      }
    }
    return this.closePromise;
  }

  initialize(): Promise<{ userAgent: string; platformFamily: string; platformOs: string }> {
    this.initializePromise ??= this.initializeOnce();
    return this.initializePromise;
  }

  private async initializeOnce() {
    const params = {
      clientInfo: { name: "aimd-reader", title: "AIMD Reader", version: "0.1.0" },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
        mcpServerOpenaiFormElicitation: false,
        optOutNotificationMethods: [],
        extensions: {},
      },
    } satisfies GeneratedInitializeParamsAdapter;
    const result = await this.requestWithTimeout(
      "initialize",
      params,
      30_000,
      "APP_SERVER_INITIALIZE_TIMEOUT",
    );
    if (
      !isRecord(result) ||
      typeof result.userAgent !== "string" ||
      typeof result.codexHome !== "string" ||
      typeof result.platformFamily !== "string" ||
      typeof result.platformOs !== "string"
    ) {
      throw new AppServerClientError("APP_SERVER_INITIALIZE_INVALID");
    }
    if (
      this.options.expectedVersion !== undefined &&
      userAgentVersion(result.userAgent) !== this.options.expectedVersion
    ) {
      throw new AppServerClientError("APP_SERVER_RUNTIME_VERSION_MISMATCH");
    }
    this.rpc.notify("initialized");
    return {
      userAgent: result.userAgent,
      platformFamily: result.platformFamily,
      platformOs: result.platformOs,
    };
  }

  async readThread(threadId: string, includeTurns = false): Promise<AppServerThread> {
    const params = { threadId, includeTurns } satisfies GeneratedThreadReadParamsAdapter;
    return parseThreadResponse(
      await this.requestWithTimeout(
        "thread/read",
        params,
        30_000,
        "APP_SERVER_THREAD_READ_TIMEOUT",
      ),
    );
  }

  async forkEphemeral(input: {
    threadId: string;
    lastTurnId?: string;
    emptyCwd: string;
    developerInstructions: string;
  }): Promise<AppServerThread> {
    const safe = buildReadOnlyThreadStartParams({
      emptyCwd: input.emptyCwd,
      developerInstructions: input.developerInstructions,
    });
    const params = {
      threadId: input.threadId,
      ...(input.lastTurnId ? { lastTurnId: input.lastTurnId } : {}),
      cwd: safe.cwd,
      runtimeWorkspaceRoots: safe.runtimeWorkspaceRoots,
      approvalPolicy: safe.approvalPolicy,
      sandbox: safe.sandbox,
      config: safe.config,
      developerInstructions: safe.developerInstructions,
      ephemeral: true,
      deferGoalContinuation: true,
    } satisfies GeneratedThreadForkParamsAdapter;
    return parseThreadResponse(await this.requestWithTimeout(
      "thread/fork",
      params,
      30_000,
      "APP_SERVER_THREAD_FORK_TIMEOUT",
    ));
  }

  async startProjectEphemeralThread(input: {
    emptyCwd: string;
    developerInstructions: string;
  }): Promise<AppServerThread> {
    const safe = buildReadOnlyThreadStartParams({
      emptyCwd: input.emptyCwd,
      developerInstructions: input.developerInstructions,
    });
    return parseThreadResponse(
      await this.requestWithTimeout(
        "thread/start",
        safe,
        30_000,
        "APP_SERVER_THREAD_START_TIMEOUT",
      ),
    );
  }

  async *startTurn(
    input: {
      threadId: string;
      emptyCwd: string;
      text: string;
      outputSchema?: unknown;
    },
    signal?: AbortSignal,
  ): AsyncIterable<AppServerEvent> {
    if (signal?.aborted) {
      yield { type: "cancelled" };
      return;
    }
    const queue = new AsyncEventQueue<AppServerEvent>();
    const prestartNotifications: AppServerNotification[] = [];
    let turnId: string | undefined;
    let finished = false;
    let prestartNotificationBytes = 0;
    let prestartFailure: AppServerClientError | undefined;
    let completionTimeout: ReturnType<typeof setTimeout> | undefined;
    let interruptPromise: Promise<void> | undefined;
    let cancellationRequested = false;

    const interruptOnce = (): Promise<void> => {
      if (!turnId) return Promise.resolve();
      interruptPromise ??= this.interruptTurn(input.threadId, turnId).catch(() => undefined);
      return interruptPromise;
    };

    const finishTurn = (): void => {
      finished = true;
      if (completionTimeout) {
        clearTimeout(completionTimeout);
        completionTimeout = undefined;
      }
    };

    const handleNotification = (notification: AppServerNotification): void => {
      if (!isRecord(notification.params) || notification.params.threadId !== input.threadId) return;
      if (cancellationRequested) return;
      const params = notification.params;
      if (notification.method === "item/agentMessage/delta") {
        if (params.turnId === turnId && typeof params.delta === "string") {
          queue.push({ type: "text_delta", text: params.delta });
        }
        return;
      }
      if (notification.method === "item/started" || notification.method === "item/completed") {
        if (params.turnId === turnId && "item" in params) {
          queue.push({
            type: "item",
            phase: notification.method === "item/started" ? "started" : "completed",
            item: params.item,
          });
        }
        return;
      }
      if (notification.method !== "turn/completed") return;
      if (!isRecord(params.turn) || typeof params.turn.id !== "string") {
        finishTurn();
        queue.fail(new AppServerClientError("APP_SERVER_TURN_INVALID"));
        return;
      }
      if (params.turn.id !== turnId) return;
      try {
        queue.push({ type: "completed", turn: parseTurn(params.turn) });
        queue.end();
      } catch {
        queue.fail(new AppServerClientError("APP_SERVER_TURN_INVALID"));
      } finally {
        finishTurn();
      }
    };

    const unsubscribe = this.rpc.onNotification((notification) => {
      if (
        !turnId &&
        isPrestartTurnNotification(notification, input.threadId)
      ) {
        const notificationBytes = serializedByteLength(notification);
        if (
          notificationBytes === undefined ||
          prestartNotifications.length >= MAX_PRESTART_NOTIFICATIONS ||
          prestartNotificationBytes + notificationBytes > MAX_PRESTART_NOTIFICATION_BYTES
        ) {
          prestartFailure ??= new AppServerClientError(
            "APP_SERVER_PRESTART_BUFFER_OVERFLOW",
          );
          void this.closeConnectionOnce().catch(() => undefined);
          return;
        }
        prestartNotificationBytes += notificationBytes;
        prestartNotifications.push(notification);
        return;
      }
      handleNotification(notification);
    });
    const unsubscribeFailure = this.rpc.onFailure((error) => {
      queue.fail(new AppServerClientError(
        error.code === "APP_SERVER_EXITED"
          ? "APP_SERVER_EXITED"
          : "APP_SERVER_TRANSPORT_FAILED",
      ));
    });

    const onAbort = () => {
      if (!turnId || finished) return;
      cancellationRequested = true;
      finishTurn();
      queue.push({ type: "cancelled" });
      queue.end();
      void interruptOnce();
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    try {
      if (signal?.aborted) {
        yield { type: "cancelled" };
        return;
      }
      // Keep the request correlated until the server returns a turn id. If an
      // abort wins this race, the late id is immediately interrupted below.
      let response: unknown;
      try {
        response = await this.requestWithTimeout(
          "turn/start",
          buildReadOnlyTurnStartParams(input),
          30_000,
          "APP_SERVER_TURN_START_TIMEOUT",
        );
      } catch (error) {
        if (prestartFailure) throw prestartFailure;
        if (signal?.aborted) {
          yield { type: "cancelled" };
          return;
        }
        throw error;
      }
      if (!isRecord(response) || !("turn" in response)) {
        throw new AppServerClientError("APP_SERVER_TURN_INVALID");
      }
      const started = parseTurn(response.turn);
      turnId = started.id;
      if (prestartFailure) {
        await interruptOnce();
        throw prestartFailure;
      }
      if (signal?.aborted) {
        await interruptOnce();
        yield { type: "cancelled" };
        return;
      }
      for (const notification of prestartNotifications.splice(0)) {
        handleNotification(notification);
      }
      if (!finished) {
        completionTimeout = setTimeout(() => {
          if (finished) return;
          queue.fail(new AppServerClientError("APP_SERVER_TURN_TIMEOUT"));
          void interruptOnce();
          void this.closeConnectionOnce().catch(() => undefined);
        }, TURN_COMPLETION_TIMEOUT_MS);
      }
      yield { type: "started", turnId };

      while (true) {
        const next = await queue.next();
        if (next.done) break;
        yield next.value;
      }
    } finally {
      if (completionTimeout) clearTimeout(completionTimeout);
      if (turnId && !finished) await interruptOnce();
      finished = true;
      signal?.removeEventListener("abort", onAbort);
      unsubscribe();
      unsubscribeFailure();
    }
  }

  async interruptTurn(threadId: string, turnId: string): Promise<void> {
    const params = { threadId, turnId } satisfies GeneratedTurnInterruptParamsAdapter;
    await this.requestWithTimeout(
      "turn/interrupt",
      params,
      5_000,
      "APP_SERVER_INTERRUPT_TIMEOUT",
    );
  }

  async close(): Promise<void> {
    await this.closeConnectionOnce();
  }
}

function isPrestartTurnNotification(
  notification: AppServerNotification,
  threadId: string,
): boolean {
  return (
    isRecord(notification.params) &&
    notification.params.threadId === threadId &&
    (
      notification.method === "turn/started" ||
      notification.method === "turn/completed" ||
      notification.method === "item/agentMessage/delta" ||
      notification.method === "item/started" ||
      notification.method === "item/completed"
    )
  );
}

function serializedByteLength(value: unknown): number | undefined {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? undefined : Buffer.byteLength(serialized, "utf8");
  } catch {
    return undefined;
  }
}

const MAX_PRESTART_NOTIFICATIONS = 128;
const MAX_PRESTART_NOTIFICATION_BYTES = 262_144;
const TURN_COMPLETION_TIMEOUT_MS = 300_000;
