import { describe, expect, it, vi } from "vitest";

import {
  AppServerClient,
  AppServerClientError,
  createResolvedAppServerClient,
  type AppServerNotification,
  type AppServerRpcConnection,
  type AppServerThread,
} from "./client.js";
import { GENERATED_APP_SERVER_SCHEMA_VERSION } from "./generated-protocol.js";

class FakeRpcConnection implements AppServerRpcConnection {
  readonly requests: Array<{ method: string; params: unknown }> = [];
  readonly requestOptions: Array<{ signal?: AbortSignal; timeoutMs?: number } | undefined> = [];
  readonly notifications: Array<{ method: string; params?: unknown }> = [];
  private readonly listeners = new Set<(notification: AppServerNotification) => void>();
  private readonly failureListeners = new Set<(error: { readonly code: string }) => void>();
  private readonly responses = new Map<string, unknown[]>();
  closeCalls = 0;
  closeFailure?: unknown;

  respond(method: string, ...responses: unknown[]): void {
    this.responses.set(method, [...responses]);
  }

  request(
    method: string,
    params: unknown,
    options?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<unknown> {
    this.requests.push({ method, params });
    this.requestOptions.push(options);
    const queue = this.responses.get(method);
    if (!queue || queue.length === 0) throw new Error(`missing fake response for ${method}`);
    const response = queue.shift();
    return response instanceof Error ? Promise.reject(response) : Promise.resolve(response);
  }

  notify(method: string, params?: unknown): void {
    this.notifications.push(params === undefined ? { method } : { method, params });
  }

  onNotification(listener: (notification: AppServerNotification) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onFailure(listener: (error: { readonly code: string }) => void): () => void {
    this.failureListeners.add(listener);
    return () => this.failureListeners.delete(listener);
  }

  close(): Promise<void> {
    this.closeCalls += 1;
    if (this.closeFailure !== undefined) return Promise.reject(this.closeFailure);
    return Promise.resolve();
  }

  emit(notification: AppServerNotification): void {
    for (const listener of this.listeners) listener(notification);
  }

  fail(code: string): void {
    for (const listener of this.failureListeners) listener(new AppServerClientError(code));
  }
}

function thread(overrides: Record<string, unknown> = {}) {
  return {
    id: "side_1",
    cwd: "D:\\Project\\Fixture",
    ephemeral: true,
    forkedFromId: null,
    status: { type: "idle" },
    turns: [],
    ...overrides,
  };
}

describe("AppServerClient", () => {
  it("creates one client from the exact resolved executable and strict launch policy", () => {
    const rpc = new FakeRpcConnection();
    const calls: Array<{ executablePath: string; args: readonly string[] }> = [];
    const client = createResolvedAppServerClient(
      {
        status: "resolved",
        source: "verified_host_hint",
        executablePath: "C:\\Desktop\\codex.exe",
        executableBasename: "codex.exe",
        version: "0.151.0-alpha.7.2",
        desktopCompatibility: "matched",
        trust: "verified_host",
        exactContextEligible: true,
      },
      {
        connect: (executablePath, args) => {
          calls.push({ executablePath, args });
          return rpc;
        },
      },
    );

    expect(client).toBeInstanceOf(AppServerClient);
    expect(calls).toEqual([
      {
        executablePath: "C:\\Desktop\\codex.exe",
        args: expect.arrayContaining(["app-server", "--stdio", "--strict-config"]),
      },
    ]);
  });

  it("accepts an operator-explicit exact-context executable", () => {
    const calls: string[] = [];
    expect(() => createResolvedAppServerClient(
      {
        status: "resolved",
        source: "environment",
        executablePath: "C:\\Explicit\\codex.exe",
        executableBasename: "codex.exe",
        version: GENERATED_APP_SERVER_SCHEMA_VERSION,
        desktopCompatibility: "not_provided",
        trust: "operator_explicit",
        exactContextEligible: true,
      },
      {
        connect: () => {
          calls.push("connected");
          return new FakeRpcConnection();
        },
      },
    )).not.toThrow();
    expect(calls).toEqual(["connected"]);
  });

  it.each([
    {
      source: "path" as const,
      trust: "development_path" as const,
      exactContextEligible: false,
    },
    {
      source: "verified_host_hint" as const,
      trust: "development_path" as const,
      exactContextEligible: true,
    },
    {
      source: "environment" as const,
      trust: "operator_explicit" as const,
      exactContextEligible: false,
    },
    {
      source: "environment" as const,
      trust: "operator_explicit" as const,
      exactContextEligible: undefined,
    },
  ])(
    "refuses a resolved executable without exact-context trust: $source/$trust/$exactContextEligible",
    ({ source, trust, exactContextEligible }) => {
      const calls: string[] = [];
      expect(() => createResolvedAppServerClient(
        {
          status: "resolved",
          source,
          executablePath: "C:\\Untrusted\\codex.exe",
          executableBasename: "codex.exe",
          version: GENERATED_APP_SERVER_SCHEMA_VERSION,
          desktopCompatibility: "not_provided",
          trust,
          ...(exactContextEligible === undefined ? {} : { exactContextEligible }),
        },
        {
          connect: () => {
            calls.push("connected");
            return new FakeRpcConnection();
          },
        },
      )).toThrow("APP_SERVER_EXECUTABLE_UNTRUSTED");
      expect(calls).toEqual([]);
    },
  );

  it("refuses a resolved binary that does not match the generated schema version", () => {
    const calls: string[] = [];
    expect(() => createResolvedAppServerClient(
      {
        status: "resolved",
        source: "environment",
        executablePath: "C:\\Explicit\\codex.exe",
        executableBasename: "codex.exe",
        version: "0.152.0",
        desktopCompatibility: "not_provided",
        trust: "operator_explicit",
        exactContextEligible: true,
      },
      {
        connect: () => {
          calls.push("connected");
          return new FakeRpcConnection();
        },
      },
    )).toThrow("APP_SERVER_SCHEMA_VERSION_MISMATCH");
    expect(calls).toEqual([]);
  });

  it("refuses initialize when runtime userAgent differs from the generated schema", async () => {
    const rpc = new FakeRpcConnection();
    rpc.respond("initialize", {
      userAgent: "codex-cli/0.152.0",
      codexHome: "C:\\Users\\hidden\\.codex",
      platformFamily: "windows",
      platformOs: "windows",
    });
    const client = createResolvedAppServerClient(
      {
        status: "resolved",
        source: "verified_host_hint",
        executablePath: "C:\\Desktop\\codex.exe",
        executableBasename: "codex.exe",
        version: GENERATED_APP_SERVER_SCHEMA_VERSION,
        desktopCompatibility: "matched",
        trust: "verified_host",
        exactContextEligible: true,
      },
      { connect: () => rpc },
    );

    await expect(client.initialize()).rejects.toEqual(
      new AppServerClientError("APP_SERVER_RUNTIME_VERSION_MISMATCH"),
    );
    expect(rpc.notifications).toEqual([]);
  });

  it("initializes the generated experimental API exactly once", async () => {
    const rpc = new FakeRpcConnection();
    rpc.respond("initialize", {
      userAgent: "codex-cli/0.151.0-alpha.7.2",
      codexHome: "C:\\Users\\hidden\\.codex",
      platformFamily: "windows",
      platformOs: "windows",
    });
    const client = new AppServerClient(rpc);

    await client.initialize();
    await client.initialize();

    expect(rpc.requests).toEqual([
      {
        method: "initialize",
        params: {
          clientInfo: { name: "aimd-reader", title: "AIMD Reader", version: "0.1.0" },
          capabilities: {
            experimentalApi: true,
            requestAttestation: false,
            mcpServerOpenaiFormElicitation: false,
            optOutNotificationMethods: [],
            extensions: {},
          },
        },
      },
    ]);
    expect(rpc.notifications).toEqual([{ method: "initialized" }]);
  });

  it.each([
    { method: "initialize", timeoutCode: "APP_SERVER_INITIALIZE_TIMEOUT" },
    { method: "thread/read", timeoutCode: "APP_SERVER_THREAD_READ_TIMEOUT" },
    { method: "thread/fork", timeoutCode: "APP_SERVER_THREAD_FORK_TIMEOUT" },
    { method: "thread/start", timeoutCode: "APP_SERVER_THREAD_START_TIMEOUT" },
  ])("bounds an unresponsive $method request and poisons the connection", async ({
    method,
    timeoutCode,
  }) => {
    vi.useFakeTimers();
    try {
      const rpc = new FakeRpcConnection();
      rpc.respond(method, new Promise<never>(() => {}));
      const client = new AppServerClient(rpc);
      let pending: Promise<unknown>;
      switch (method) {
        case "initialize":
          pending = client.initialize();
          break;
        case "thread/read":
          pending = client.readThread("parent_secret", true);
          break;
        case "thread/fork":
          pending = client.forkEphemeral({
            threadId: "parent_secret",
            lastTurnId: "turn_done",
            emptyCwd: "C:\\Temp\\aimd-empty",
            developerInstructions: "server-owned policy",
          });
          break;
        default:
          pending = client.startProjectEphemeralThread({
            emptyCwd: "C:\\Temp\\aimd-empty",
            developerInstructions: "project evidence only",
          });
      }
      const rejection = expect(pending).rejects.toEqual(
        new AppServerClientError(timeoutCode),
      );

      await vi.advanceTimersByTimeAsync(30_000);

      await rejection;
      expect(rpc.requestOptions[0]).toEqual({ timeoutMs: 30_000 });
      expect(rpc.closeCalls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a sanitized background close rejection observable to explicit shutdown", async () => {
    vi.useFakeTimers();
    try {
      const rpc = new FakeRpcConnection();
      rpc.respond("thread/read", new Promise<never>(() => {}));
      rpc.closeFailure = {
        code: "APP_SERVER_CLOSE_TIMEOUT",
        message: "thr_close_secret C:\\Users\\private\\secret-codex.exe",
      };
      const client = new AppServerClient(rpc);
      const pending = client.readThread("thr_secret", true);
      const pendingRejection = expect(pending).rejects.toEqual(
        new AppServerClientError("APP_SERVER_THREAD_READ_TIMEOUT"),
      );

      await vi.advanceTimersByTimeAsync(30_000);

      await pendingRejection;
      const first = client.close();
      const second = client.close();
      await expect(first).rejects.toEqual(
        new AppServerClientError("APP_SERVER_CLOSE_TIMEOUT"),
      );
      await expect(second).rejects.toEqual(
        new AppServerClientError("APP_SERVER_CLOSE_TIMEOUT"),
      );
      expect(rpc.closeCalls).toBe(1);
      expect(String(await first.catch((error: unknown) => (error as Error).message)))
        .not.toMatch(/thr_close_secret|Users|secret-codex/u);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reads one exact thread with turns and never lists to guess", async () => {
    const rpc = new FakeRpcConnection();
    rpc.respond("thread/read", { thread: thread({ id: "parent_exact" }) });
    const client = new AppServerClient(rpc);

    await expect(client.readThread("parent_exact", true)).resolves.toMatchObject({
      id: "parent_exact",
    });
    expect(rpc.requests).toEqual([
      { method: "thread/read", params: { threadId: "parent_exact", includeTurns: true } },
    ]);
    expect(rpc.requests.some((call) => call.method === "thread/list")).toBe(false);
  });

  it.each([
    { type: "futureActive" },
    { type: "active" },
    { type: "active", activeFlags: ["futureFlag"] },
  ])("rejects a thread with a non-generated status shape: $type", async (status) => {
    const rpc = new FakeRpcConnection();
    rpc.respond("thread/read", { thread: thread({ status }) });
    const client = new AppServerClient(rpc);

    await expect(client.readThread("parent_exact", true)).rejects.toEqual(
      new AppServerClientError("APP_SERVER_THREAD_INVALID"),
    );
  });

  it("retains generated nested protocol ids for public-output redaction", async () => {
    const rpc = new FakeRpcConnection();
    rpc.respond("thread/read", {
      thread: thread({
        id: "parent_secret",
        sessionId: "session_internal_secret",
        projectId: "project_internal_secret",
        turns: [{
          id: "turn_done",
          status: "completed",
          items: [{
            type: "collabAgentToolCall",
            id: "item_internal_secret",
            senderThreadId: "sender_internal_secret",
            receiverThreadIds: ["receiver_internal_secret"],
          }],
        }],
      }),
    });
    const client = new AppServerClient(rpc);

    const result = await client.readThread("parent_secret", true) as AppServerThread & {
      internalIds?: string[];
    };

    expect(result.internalIds).toEqual(expect.arrayContaining([
      "parent_secret",
      "session_internal_secret",
      "project_internal_secret",
      "turn_done",
      "item_internal_secret",
      "sender_internal_secret",
      "receiver_internal_secret",
    ]));
  });

  it("forks only through the requested completed turn as ephemeral read-only", async () => {
    const rpc = new FakeRpcConnection();
    rpc.respond("thread/fork", {
      thread: thread({ id: "side_fork", forkedFromId: "parent_exact" }),
    });
    const client = new AppServerClient(rpc);

    await client.forkEphemeral({
      threadId: "parent_exact",
      lastTurnId: "turn_done",
      emptyCwd: "C:\\Temp\\aimd-empty",
      developerInstructions: "server-owned project evidence policy",
    });

    expect(rpc.requests).toEqual([
      {
        method: "thread/fork",
        params: {
          threadId: "parent_exact",
          lastTurnId: "turn_done",
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
          developerInstructions: "server-owned project evidence policy",
          ephemeral: true,
          deferGoalContinuation: true,
        },
      },
    ]);
  });

  it("starts a clean project-only ephemeral thread without inherited environments or tools", async () => {
    const rpc = new FakeRpcConnection();
    rpc.respond("thread/start", { thread: thread({ id: "side_project" }) });
    const client = new AppServerClient(rpc);

    await client.startProjectEphemeralThread({
      emptyCwd: "C:\\Temp\\aimd-empty",
      developerInstructions: "server-owned project evidence policy",
    });

    expect(rpc.requests[0]).toMatchObject({
      method: "thread/start",
      params: {
        cwd: "C:\\Temp\\aimd-empty",
        runtimeWorkspaceRoots: [],
        approvalPolicy: "never",
        sandbox: "read-only",
        developerInstructions: "server-owned project evidence policy",
        ephemeral: true,
        environments: [],
        dynamicTools: [],
      },
    });
  });

  it("reports model isolation as unproven until the generated host exposes an effective tool attestation", () => {
    const client = new AppServerClient(new FakeRpcConnection());
    expect(client.modelIsolationResult()).toEqual({
      status: "reader_only",
      code: "MODEL_ISOLATION_UNPROVEN",
      missing: ["effectiveTools.hostAttestation"],
    });
  });

  it("streams only notifications correlated to the started thread and turn", async () => {
    const rpc = new FakeRpcConnection();
    rpc.respond("turn/start", {
      turn: {
        id: "turn_side",
        status: "inProgress",
        items: [],
        startedAt: 1,
        completedAt: null,
      },
    });
    const client = new AppServerClient(rpc);
    const iterator = client.startTurn({
      threadId: "side_1",
      emptyCwd: "C:\\Temp\\aimd-empty",
      text: "bounded packet",
      outputSchema: { type: "object" },
    })[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: "started", turnId: "turn_side" },
      done: false,
    });
    const delta = iterator.next();
    rpc.emit({
      method: "item/agentMessage/delta",
      params: { threadId: "other", turnId: "turn_side", itemId: "i0", delta: "ignore" },
    });
    rpc.emit({
      method: "item/agentMessage/delta",
      params: { threadId: "side_1", turnId: "turn_side", itemId: "i1", delta: "answer" },
    });
    await expect(delta).resolves.toEqual({ value: { type: "text_delta", text: "answer" }, done: false });

    const completed = iterator.next();
    rpc.emit({
      method: "turn/completed",
      params: {
        threadId: "side_1",
        turn: { id: "turn_side", status: "completed", items: [] },
      },
    });
    await expect(completed).resolves.toMatchObject({
      value: { type: "completed", turn: { id: "turn_side", status: "completed" } },
      done: false,
    });
    await expect(iterator.next()).resolves.toEqual({ value: undefined, done: true });
  });

  it("replays a bounded terminal notification that arrives before turn/start responds", async () => {
    const rpc = new FakeRpcConnection();
    let resolveStart!: (value: unknown) => void;
    rpc.respond("turn/start", new Promise<unknown>((resolve) => {
      resolveStart = resolve;
    }));
    const client = new AppServerClient(rpc);
    const iterator = client.startTurn({
      threadId: "side_1",
      emptyCwd: "C:\\Temp\\aimd-empty",
      text: "bounded packet",
    })[Symbol.asyncIterator]();
    const started = iterator.next();
    await Promise.resolve();

    rpc.emit({
      method: "turn/completed",
      params: {
        threadId: "side_1",
        turn: { id: "turn_side", status: "completed", items: [] },
      },
    });
    resolveStart({
      turn: { id: "turn_side", status: "inProgress", items: [] },
    });

    await expect(started).resolves.toEqual({
      value: { type: "started", turnId: "turn_side" },
      done: false,
    });
    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: "completed", turn: { id: "turn_side", status: "completed" } },
      done: false,
    });
    await expect(iterator.next()).resolves.toEqual({ value: undefined, done: true });
  });

  it("fails closed when the bounded pre-response notification buffer overflows", async () => {
    const rpc = new FakeRpcConnection();
    let resolveStart!: (value: unknown) => void;
    rpc.respond("turn/start", new Promise<unknown>((resolve) => {
      resolveStart = resolve;
    }));
    rpc.respond("turn/interrupt", {});
    const client = new AppServerClient(rpc);
    const iterator = client.startTurn({
      threadId: "side_1",
      emptyCwd: "C:\\Temp\\aimd-empty",
      text: "bounded packet",
    })[Symbol.asyncIterator]();
    const started = iterator.next();
    await Promise.resolve();

    for (let index = 0; index < 129; index += 1) {
      rpc.emit({
        method: "item/started",
        params: {
          threadId: "side_1",
          turnId: "turn_side",
          item: { id: `item_${index}` },
        },
      });
    }
    resolveStart({
      turn: { id: "turn_side", status: "inProgress", items: [] },
    });

    await expect(started).rejects.toEqual(
      new AppServerClientError("APP_SERVER_PRESTART_BUFFER_OVERFLOW"),
    );
    expect(rpc.requests.filter((request) => request.method === "turn/interrupt")).toHaveLength(1);
    expect(rpc.closeCalls).toBe(1);
  });

  it("interrupts exactly once when the async iterator consumer returns early", async () => {
    const rpc = new FakeRpcConnection();
    rpc.respond("turn/start", {
      turn: { id: "turn_side", status: "inProgress", items: [] },
    });
    rpc.respond("turn/interrupt", {});
    const client = new AppServerClient(rpc);
    const iterator = client.startTurn({
      threadId: "side_1",
      emptyCwd: "C:\\Temp\\aimd-empty",
      text: "bounded packet",
    })[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: "started", turnId: "turn_side" },
    });
    await iterator.return?.();

    expect(rpc.requests.filter((request) => request.method === "turn/interrupt")).toEqual([
      {
        method: "turn/interrupt",
        params: { threadId: "side_1", turnId: "turn_side" },
      },
    ]);
  });

  it("times out an unterminated turn with exactly one interrupt and poisons the connection", async () => {
    vi.useFakeTimers();
    try {
      const rpc = new FakeRpcConnection();
      rpc.respond("turn/start", {
        turn: { id: "turn_side", status: "inProgress", items: [] },
      });
      rpc.respond("turn/interrupt", {});
      const client = new AppServerClient(rpc);
      const iterator = client.startTurn({
        threadId: "side_1",
        emptyCwd: "C:\\Temp\\aimd-empty",
        text: "bounded packet",
      })[Symbol.asyncIterator]();
      await iterator.next();
      const terminal = iterator.next();
      const terminalRejection = expect(terminal).rejects.toEqual(
        new AppServerClientError("APP_SERVER_TURN_TIMEOUT"),
      );

      await vi.advanceTimersByTimeAsync(300_000);

      await terminalRejection;
      expect(rpc.requests.filter((request) => request.method === "turn/interrupt")).toHaveLength(1);
      expect(rpc.closeCalls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("turns a malformed terminal notification into a fixed iterator failure", async () => {
    const rpc = new FakeRpcConnection();
    rpc.respond("turn/start", {
      turn: { id: "turn_side", status: "inProgress", items: [] },
    });
    const client = new AppServerClient(rpc);
    const iterator = client.startTurn({
      threadId: "side_1",
      emptyCwd: "C:\\Temp\\aimd-empty",
      text: "bounded packet",
    })[Symbol.asyncIterator]();
    await iterator.next();
    const terminal = iterator.next();

    expect(() => rpc.emit({
      method: "turn/completed",
      params: {
        threadId: "side_1",
        turn: {
          id: "turn_side",
          status: "completed",
          items: "thr_secret C:\\Users\\private question excerpt",
        },
      },
    })).not.toThrow();
    await expect(terminal).rejects.toEqual(
      new AppServerClientError("APP_SERVER_TURN_INVALID"),
    );
  });

  it("fails a terminal notification whose turn id is missing instead of hanging", async () => {
    const rpc = new FakeRpcConnection();
    rpc.respond("turn/start", {
      turn: { id: "turn_side", status: "inProgress", items: [] },
    });
    const client = new AppServerClient(rpc);
    const iterator = client.startTurn({
      threadId: "side_1",
      emptyCwd: "C:\\Temp\\aimd-empty",
      text: "bounded packet",
    })[Symbol.asyncIterator]();
    await iterator.next();
    const terminal = iterator.next();

    rpc.emit({
      method: "turn/completed",
      params: {
        threadId: "side_1",
        turn: { status: "completed", items: [] },
      },
    });

    await expect(terminal).rejects.toEqual(
      new AppServerClientError("APP_SERVER_TURN_INVALID"),
    );
  });

  it("does not send turn/start when the signal is already aborted", async () => {
    const rpc = new FakeRpcConnection();
    const client = new AppServerClient(rpc);
    const controller = new AbortController();
    controller.abort();
    const iterator = client.startTurn(
      {
        threadId: "side_1",
        emptyCwd: "C:\\Temp\\aimd-empty",
        text: "bounded packet",
      },
      controller.signal,
    )[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toEqual({
      value: { type: "cancelled" },
      done: false,
    });
    await expect(iterator.next()).resolves.toEqual({ value: undefined, done: true });
    expect(rpc.requests).toHaveLength(0);
  });

  it("keeps turn/start correlation through an abort race and interrupts the late turn", async () => {
    const rpc = new FakeRpcConnection();
    let resolveStart!: (value: unknown) => void;
    const delayedStart = new Promise<unknown>((resolve) => {
      resolveStart = resolve;
    });
    rpc.respond("turn/start", delayedStart);
    rpc.respond("turn/interrupt", {});
    const client = new AppServerClient(rpc);
    const controller = new AbortController();
    const iterator = client.startTurn(
      {
        threadId: "side_1",
        emptyCwd: "C:\\Temp\\aimd-empty",
        text: "bounded packet",
      },
      controller.signal,
    )[Symbol.asyncIterator]();

    const terminal = iterator.next();
    await Promise.resolve();
    controller.abort();
    resolveStart({
      turn: { id: "turn_late", status: "inProgress", items: [] },
    });

    await expect(terminal).resolves.toEqual({
      value: { type: "cancelled" },
      done: false,
    });
    await expect(iterator.next()).resolves.toEqual({ value: undefined, done: true });
    expect(rpc.requestOptions[0]).toEqual({ timeoutMs: 30_000 });
    expect(rpc.requests.at(-1)).toEqual({
      method: "turn/interrupt",
      params: { threadId: "side_1", turnId: "turn_late" },
    });
  });

  it("interrupts the correlated App Server turn on cancellation", async () => {
    const rpc = new FakeRpcConnection();
    rpc.respond("turn/start", { turn: { id: "turn_side", status: "inProgress", items: [] } });
    rpc.respond("turn/interrupt", {});
    const client = new AppServerClient(rpc);
    const controller = new AbortController();
    const iterator = client.startTurn(
      {
        threadId: "side_1",
        emptyCwd: "C:\\Temp\\aimd-empty",
        text: "bounded packet",
      },
      controller.signal,
    )[Symbol.asyncIterator]();
    await iterator.next();
    controller.abort();
    await expect(iterator.next()).resolves.toEqual({ value: { type: "cancelled" }, done: false });
    expect(rpc.requests.at(-1)).toEqual({
      method: "turn/interrupt",
      params: { threadId: "side_1", turnId: "turn_side" },
    });
  });

  it("lets cancellation win when completion arrives before interrupt settles", async () => {
    const rpc = new FakeRpcConnection();
    rpc.respond("turn/start", {
      turn: { id: "turn_side", status: "inProgress", items: [] },
    });
    let resolveInterrupt!: (value: unknown) => void;
    rpc.respond("turn/interrupt", new Promise<unknown>((resolve) => {
      resolveInterrupt = resolve;
    }));
    const client = new AppServerClient(rpc);
    const controller = new AbortController();
    const iterator = client.startTurn(
      {
        threadId: "side_1",
        emptyCwd: "C:\\Temp\\aimd-empty",
        text: "bounded packet",
      },
      controller.signal,
    )[Symbol.asyncIterator]();

    await iterator.next();
    controller.abort();
    const terminal = iterator.next();
    rpc.emit({
      method: "turn/completed",
      params: {
        threadId: "side_1",
        turn: { id: "turn_side", status: "completed", items: [] },
      },
    });

    await expect(terminal).resolves.toEqual({
      value: { type: "cancelled" },
      done: false,
    });
    resolveInterrupt({});
    await expect(iterator.next()).resolves.toEqual({ value: undefined, done: true });
    expect(rpc.requests.filter((request) => request.method === "turn/interrupt")).toHaveLength(1);
  });

  it("bounds an abort whose turn/start response never arrives", async () => {
    vi.useFakeTimers();
    try {
      const rpc = new FakeRpcConnection();
      rpc.respond("turn/start", new Promise<never>(() => {}));
      const client = new AppServerClient(rpc);
      const controller = new AbortController();
      const iterator = client.startTurn(
        {
          threadId: "side_1",
          emptyCwd: "C:\\Temp\\aimd-empty",
          text: "bounded packet",
        },
        controller.signal,
      )[Symbol.asyncIterator]();
      const cancelled = iterator.next();
      await Promise.resolve();
      controller.abort();

      await vi.advanceTimersByTimeAsync(30_000);

      await expect(cancelled).resolves.toEqual({
        value: { type: "cancelled" },
        done: false,
      });
      expect(rpc.requestOptions[0]).toEqual({ timeoutMs: 30_000 });
      expect(rpc.requests.some((request) => request.method === "turn/interrupt")).toBe(false);
      expect(rpc.closeCalls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("terminates an active turn with a fixed error when App Server exits", async () => {
    const rpc = new FakeRpcConnection();
    rpc.respond("turn/start", {
      turn: { id: "turn_side", status: "inProgress", items: [] },
    });
    const client = new AppServerClient(rpc);
    const iterator = client.startTurn({
      threadId: "side_1",
      emptyCwd: "C:\\Temp\\aimd-empty",
      text: "private question C:\\Users\\hidden",
    })[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: "started", turnId: "turn_side" },
    });
    const terminal = iterator.next();
    rpc.fail("APP_SERVER_EXITED");

    await expect(terminal).rejects.toEqual(new AppServerClientError("APP_SERVER_EXITED"));
  });

  it("cancels cleanly when the interrupt request rejects with hostile details", async () => {
    const rpc = new FakeRpcConnection();
    rpc.respond("turn/start", {
      turn: { id: "turn_side", status: "inProgress", items: [] },
    });
    rpc.respond(
      "turn/interrupt",
      new Error("turn_secret C:\\Users\\hidden private question excerpt"),
    );
    const client = new AppServerClient(rpc);
    const controller = new AbortController();
    const iterator = client.startTurn(
      {
        threadId: "side_1",
        emptyCwd: "C:\\Temp\\aimd-empty",
        text: "bounded packet",
      },
      controller.signal,
    )[Symbol.asyncIterator]();

    await iterator.next();
    controller.abort();

    await expect(iterator.next()).resolves.toEqual({
      value: { type: "cancelled" },
      done: false,
    });
    await expect(iterator.next()).resolves.toEqual({ value: undefined, done: true });
  });

  it("bounds a hung interrupt and still terminates cancellation", async () => {
    vi.useFakeTimers();
    try {
      const rpc = new FakeRpcConnection();
      rpc.respond("turn/start", {
        turn: { id: "turn_side", status: "inProgress", items: [] },
      });
      rpc.respond("turn/interrupt", new Promise<never>(() => {}));
      const client = new AppServerClient(rpc);
      const controller = new AbortController();
      const iterator = client.startTurn(
        {
          threadId: "side_1",
          emptyCwd: "C:\\Temp\\aimd-empty",
          text: "bounded packet",
        },
        controller.signal,
      )[Symbol.asyncIterator]();
      await iterator.next();
      controller.abort();
      const cancelled = iterator.next();

      await vi.advanceTimersByTimeAsync(5_000);

      await expect(cancelled).resolves.toEqual({
        value: { type: "cancelled" },
        done: false,
      });
      expect(rpc.requestOptions.at(-1)).toEqual({ timeoutMs: 5_000 });
      expect(rpc.closeCalls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns fixed errors instead of leaking malformed response fields", async () => {
    const rpc = new FakeRpcConnection();
    rpc.respond("thread/read", {
      thread: { id: "thr_secret", cwd: "C:\\Users\\secret", prompt: "private question" },
    });
    const client = new AppServerClient(rpc);
    await expect(client.readThread("thr_secret", true)).rejects.toThrow("APP_SERVER_THREAD_INVALID");
  });
});
