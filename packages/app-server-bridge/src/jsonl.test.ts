import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
}));

import {
  AppServerTransportError,
  JsonlRpcClient,
  sanitizeStderrLine,
  spawnStdioJsonlTransport,
  StdioJsonlTransport,
  type SpawnedJsonlProcess,
  type JsonlLineTransport,
  type StructuredDiagnostic,
} from "./jsonl.js";

class FakeReadable {
  private readonly dataListeners = new Set<(chunk: Uint8Array | string) => void>();
  private readonly errorListeners = new Set<(error: unknown) => void>();
  private readonly terminalListeners = new Map<"end" | "close", Set<() => void>>([
    ["end", new Set()],
    ["close", new Set()],
  ]);
  on(event: "data", listener: (chunk: Uint8Array | string) => void): this;
  on(event: "error", listener: (error: unknown) => void): this;
  on(event: "end" | "close", listener: () => void): this;
  on(
    event: "data" | "error" | "end" | "close",
    listener: ((chunk: Uint8Array | string) => void) | ((error: unknown) => void) | (() => void),
  ): this {
    if (event === "data") {
      this.dataListeners.add(listener as (chunk: Uint8Array | string) => void);
    } else if (event === "error") {
      this.errorListeners.add(listener as (error: unknown) => void);
    } else {
      this.terminalListeners.get(event)?.add(listener as () => void);
    }
    return this;
  }
  emit(chunk: Uint8Array | string): void {
    for (const listener of this.dataListeners) listener(chunk);
  }
}

class FakeSpawnedProcess implements SpawnedJsonlProcess {
  readonly stdout = new FakeReadable();
  readonly stderr = new FakeReadable();
  private readonly stdinErrorListeners = new Set<(error: unknown) => void>();
  readonly stdin = {
    writes: [] as string[],
    ended: false,
    write: (chunk: string) => {
      this.stdin.writes.push(chunk);
      return true;
    },
    end: () => {
      this.stdin.ended = true;
    },
    on: (_event: "error", listener: (error: unknown) => void) => {
      this.stdinErrorListeners.add(listener);
      return this.stdin;
    },
  };
  private readonly exitListeners = new Set<(code: number | null, signal: string | null) => void>();
  private readonly errorListeners = new Set<(error: unknown) => void>();
  killed = false;
  killResult = true;
  killFailure?: Error;
  on(event: "exit", listener: (code: number | null, signal: string | null) => void): this;
  on(event: "error", listener: (error: unknown) => void): this;
  on(
    event: "exit" | "error",
    listener: ((code: number | null, signal: string | null) => void) | ((error: unknown) => void),
  ): this {
    if (event === "exit") {
      this.exitListeners.add(
        listener as (code: number | null, signal: string | null) => void,
      );
    } else {
      this.errorListeners.add(listener as (error: unknown) => void);
    }
    return this;
  }
  kill(): boolean {
    this.killed = true;
    if (this.killFailure) throw this.killFailure;
    return this.killResult;
  }
  exit(code: number | null, signal: string | null = null): void {
    for (const listener of this.exitListeners) listener(code, signal);
  }
}

class MemoryLineTransport implements JsonlLineTransport {
  readonly writes: string[] = [];
  closeCalls = 0;
  closeFailure?: unknown;
  writeFailure?: unknown;
  private lineListeners = new Set<(line: string) => void>();
  private exitListeners = new Set<(exit: { code: number | null; signal: string | null }) => void>();
  private diagnosticListeners = new Set<(diagnostic: StructuredDiagnostic) => void>();

  writeLine(line: string): void {
    if (this.writeFailure !== undefined) throw this.writeFailure;
    this.writes.push(line);
  }

  onLine(listener: (line: string) => void): () => void {
    this.lineListeners.add(listener);
    return () => this.lineListeners.delete(listener);
  }

  onExit(listener: (exit: { code: number | null; signal: string | null }) => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  onDiagnostic(listener: (diagnostic: StructuredDiagnostic) => void): () => void {
    this.diagnosticListeners.add(listener);
    return () => this.diagnosticListeners.delete(listener);
  }

  close(): void | Promise<void> {
    this.closeCalls += 1;
    if (this.closeFailure !== undefined) return Promise.reject(this.closeFailure);
  }

  receive(line: string): void {
    for (const listener of this.lineListeners) listener(line);
  }

  receiveStderr(line: string): void {
    const diagnostic = sanitizeStderrLine(line);
    if (!diagnostic) return;
    for (const listener of this.diagnosticListeners) listener(diagnostic);
  }

  exit(code: number | null, signal: string | null = null): void {
    for (const listener of this.exitListeners) listener({ code, signal });
  }
}

class EventedWritable extends EventEmitter {
  readonly writes: string[] = [];
  ended = false;

  write(chunk: string): boolean {
    this.writes.push(chunk);
    return true;
  }

  end(): void {
    this.ended = true;
  }
}

class EventedSpawnedProcess extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly stdin = new EventedWritable();
  killed = false;

  kill(): boolean {
    this.killed = true;
    return true;
  }
}

describe("JsonlRpcClient", () => {
  it("correlates out-of-order responses by request id", async () => {
    const transport = new MemoryLineTransport();
    const client = new JsonlRpcClient(transport);
    const first = client.request("thread/read", { threadId: "thr_one" });
    const second = client.request("thread/read", { threadId: "thr_two" });
    const firstRequest = JSON.parse(transport.writes[0] ?? "null") as { id: number };
    const secondRequest = JSON.parse(transport.writes[1] ?? "null") as { id: number };

    transport.receive(JSON.stringify({ id: secondRequest.id, result: { thread: { id: "thr_two" } } }));
    transport.receive(JSON.stringify({ id: firstRequest.id, result: { thread: { id: "thr_one" } } }));

    await expect(first).resolves.toEqual({ thread: { id: "thr_one" } });
    await expect(second).resolves.toEqual({ thread: { id: "thr_two" } });
  });

  it("delivers notifications without confusing them with responses", () => {
    const transport = new MemoryLineTransport();
    const client = new JsonlRpcClient(transport);
    const received: unknown[] = [];
    client.onNotification((notification) => received.push(notification));

    transport.receive(JSON.stringify({ method: "turn/started", params: { turn: { id: "turn_1" } } }));

    expect(received).toEqual([
      { method: "turn/started", params: { turn: { id: "turn_1" } } },
    ]);
  });

  it("never delivers notifications after a malformed line poisons the connection", () => {
    const transport = new MemoryLineTransport();
    const client = new JsonlRpcClient(transport);
    const received: unknown[] = [];
    client.onNotification((notification) => received.push(notification));

    transport.receive("not-json");
    transport.receive(JSON.stringify({
      method: "item/agentMessage/delta",
      params: {
        threadId: "thr_secret",
        turnId: "turn_secret",
        delta: "private question excerpt",
      },
    }));

    expect(received).toEqual([]);
    expect(transport.closeCalls).toBe(1);
  });

  it("writes client notifications without a request id", () => {
    const transport = new MemoryLineTransport();
    const client = new JsonlRpcClient(transport);
    client.notify("initialized");
    expect(JSON.parse(transport.writes[0] ?? "null")).toEqual({ method: "initialized" });
  });

  it("rejects pending work on a malformed stdout line without exposing the line", async () => {
    const transport = new MemoryLineTransport();
    const diagnostics: StructuredDiagnostic[] = [];
    const client = new JsonlRpcClient(transport, { onDiagnostic: (item) => diagnostics.push(item) });
    const pending = client.request("thread/read", { threadId: "thr_secret" });

    transport.receive('{"broken":"thr_secret C:\\\\Users\\\\secret question excerpt"');

    await expect(pending).rejects.toMatchObject({ code: "APP_SERVER_MALFORMED_JSONL" });
    expect(transport.closeCalls).toBe(1);
    expect(JSON.stringify(diagnostics)).not.toContain("thr_secret");
    expect(JSON.stringify(diagnostics)).not.toContain("Users");
    expect(JSON.stringify(diagnostics)).not.toContain("question excerpt");
  });

  it("poisons and closes the transport on a protocol-invalid line", async () => {
    const transport = new MemoryLineTransport();
    const client = new JsonlRpcClient(transport);
    const pending = client.request("turn/start", { threadId: "thr_secret" });

    transport.receive(JSON.stringify({ unexpected: "thr_secret C:\\Users\\private" }));

    await expect(pending).rejects.toEqual(
      new AppServerTransportError("APP_SERVER_PROTOCOL_ERROR"),
    );
    expect(transport.closeCalls).toBe(1);
    await expect(client.request("thread/read", {})).rejects.toEqual(
      new AppServerTransportError("APP_SERVER_UNAVAILABLE"),
    );
  });

  it("poisons a correlated response that contains both result and error", async () => {
    const transport = new MemoryLineTransport();
    const client = new JsonlRpcClient(transport);
    const pending = client.request("thread/read", { threadId: "thr_secret" });
    const request = JSON.parse(transport.writes[0] ?? "null") as { id: number };

    transport.receive(JSON.stringify({
      id: request.id,
      result: { thread: { id: "thr_secret" } },
      error: { message: "C:\\Users\\private private question excerpt" },
    }));

    await expect(pending).rejects.toEqual(
      new AppServerTransportError("APP_SERVER_PROTOCOL_ERROR"),
    );
    expect(transport.closeCalls).toBe(1);
  });

  it("rejects pending work when the child process exits", async () => {
    const transport = new MemoryLineTransport();
    const client = new JsonlRpcClient(transport);
    const pending = client.request("thread/read", { threadId: "thr_one" });
    transport.exit(17);
    await expect(pending).rejects.toEqual(
      new AppServerTransportError("APP_SERVER_EXITED"),
    );
  });

  it("removes a cancelled request and ignores its later response", async () => {
    const transport = new MemoryLineTransport();
    const client = new JsonlRpcClient(transport);
    const controller = new AbortController();
    const pending = client.request("thread/read", { threadId: "thr_one" }, { signal: controller.signal });
    const request = JSON.parse(transport.writes[0] ?? "null") as { id: number };
    controller.abort();
    transport.receive(JSON.stringify({ id: request.id, result: { private: "late" } }));
    await expect(pending).rejects.toMatchObject({ code: "APP_SERVER_CANCELLED" });
  });

  it("times out pending work with a fixed error and ignores its later response", async () => {
    const transport = new MemoryLineTransport();
    const client = new JsonlRpcClient(transport);
    const pending = client.request(
      "thread/read",
      { threadId: "thr_one" },
      { timeoutMs: 1 },
    );
    const request = JSON.parse(transport.writes[0] ?? "null") as { id: number };

    await expect(pending).rejects.toMatchObject({ code: "APP_SERVER_TIMEOUT" });
    expect(transport.closeCalls).toBe(1);
    transport.receive(JSON.stringify({ id: request.id, result: { private: "late" } }));
  });

  it("notifies active streams of a fixed process failure even with no pending request", () => {
    const transport = new MemoryLineTransport();
    const client = new JsonlRpcClient(transport);
    const failures: string[] = [];
    client.onFailure((error) => failures.push(error.code));

    transport.exit(17);

    expect(failures).toEqual(["APP_SERVER_EXITED"]);
  });

  it("sanitizes a transport write exception and removes the pending request", async () => {
    const transport = new MemoryLineTransport();
    transport.writeFailure = new Error(
      "thr_secret turn_secret C:\\Users\\private question excerpt",
    );
    const client = new JsonlRpcClient(transport);

    await expect(client.request("thread/read", { threadId: "thr_secret" })).rejects.toEqual(
      new AppServerTransportError("APP_SERVER_WRITE_FAILED"),
    );
    await client.close();
  });

  it("discards hostile stderr and emits only bounded allowlisted diagnostics", () => {
    const transport = new MemoryLineTransport();
    const diagnostics: StructuredDiagnostic[] = [];
    new JsonlRpcClient(transport, { onDiagnostic: (item) => diagnostics.push(item) });

    transport.receiveStderr("thr_secret turn_secret C:\\Users\\private question source excerpt");
    transport.receiveStderr("codex-cli privatequestion");
    transport.receiveStderr("codex-cli parent-secret-id");
    transport.receiveStderr("codex-cli 01.2.3");
    transport.receiveStderr("codex-cli 0.151.0-alpha.7.2");

    expect(diagnostics).toEqual([
      {
        code: "APP_SERVER_VERSION",
        component: "app-server",
        version: "0.151.0-alpha.7.2",
        retryable: false,
      },
    ]);
    const serialized = JSON.stringify(diagnostics);
    expect(serialized.length).toBeLessThan(256);
    for (const secret of [
      "thr_secret",
      "turn_secret",
      "Users",
      "private question",
      "source excerpt",
      "privatequestion",
      "parent-secret-id",
      "01.2.3",
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("preserves a fixed rejected transport close for explicit shutdown after background poison", async () => {
    const transport = new MemoryLineTransport();
    transport.closeFailure = new Error(
      "thr_close_secret C:\\Users\\private executable.exe private question",
    );
    const client = new JsonlRpcClient(transport);
    const pending = client.request("thread/read", { threadId: "thr_secret" });

    transport.receive("not-json");

    await expect(pending).rejects.toEqual(
      new AppServerTransportError("APP_SERVER_MALFORMED_JSONL"),
    );
    const first = client.close();
    const second = client.close();
    await expect(first).rejects.toEqual(
      new AppServerTransportError("APP_SERVER_CLOSE_FAILED"),
    );
    await expect(second).rejects.toEqual(
      new AppServerTransportError("APP_SERVER_CLOSE_FAILED"),
    );
    expect(transport.closeCalls).toBe(1);
    expect(String(await first.catch((error: unknown) => (error as Error).message)))
      .not.toMatch(/thr_close_secret|Users|executable\.exe|private question/u);
  });
});

describe("StdioJsonlTransport", () => {
  it.each(["end", "close"] as const)(
    "rejects pending RPC immediately when stdout emits %s while the child is still alive",
    async (eventName) => {
      const child = new EventedSpawnedProcess();
      const transport = new StdioJsonlTransport(child);
      const client = new JsonlRpcClient(transport);
      const pending = client.request("thread/read", { threadId: "thr_secret" });
      const request = JSON.parse(child.stdin.writes[0] ?? "null") as { id: number };
      child.stdout.emit("data", JSON.stringify({
        id: request.id,
        result: { thread: { id: "thr_secret" } },
      }));

      child.stdout.emit(eventName);

      await expect(pending).rejects.toEqual(
        new AppServerTransportError("APP_SERVER_EXITED"),
      );
      expect(child.killed).toBe(true);
      child.emit("exit", null, "SIGTERM");
      await expect(client.close()).resolves.toBeUndefined();
    },
  );

  it("rejects a complete but newline-unterminated response when the child exits", async () => {
    const child = new EventedSpawnedProcess();
    const transport = new StdioJsonlTransport(child);
    const client = new JsonlRpcClient(transport);
    const pending = client.request("thread/read", { threadId: "thr_secret" });
    const request = JSON.parse(child.stdin.writes[0] ?? "null") as { id: number };
    child.stdout.emit("data", JSON.stringify({
      id: request.id,
      result: { thread: { id: "thr_secret" } },
    }));

    child.emit("exit", 0, null);

    await expect(pending).rejects.toEqual(
      new AppServerTransportError("APP_SERVER_EXITED"),
    );
    await expect(client.close()).resolves.toBeUndefined();
  });

  it.each(["end", "close", "exit"] as const)(
    "never delivers a newline-unterminated completion when stdout terminates via %s",
    async (eventName) => {
      const child = new EventedSpawnedProcess();
      const transport = new StdioJsonlTransport(child);
      const client = new JsonlRpcClient(transport);
      const notifications: unknown[] = [];
      client.onNotification((notification) => notifications.push(notification));
      child.stdout.emit("data", JSON.stringify({
        method: "turn/completed",
        params: {
          thread: { id: "thr_secret" },
          turn: { id: "turn_secret", status: "completed", items: [] },
        },
      }));

      if (eventName === "exit") child.emit("exit", 0, null);
      else {
        child.stdout.emit(eventName);
        child.emit("exit", null, "SIGTERM");
      }

      expect(notifications).toEqual([]);
      await expect(client.close()).resolves.toBeUndefined();
    },
  );

  it("sanitizes kill failure when spawned stdio streams are unavailable", () => {
    const child = new EventEmitter() as EventEmitter & {
      stdin: EventedWritable;
      stdout: null;
      stderr: EventEmitter;
      kill(): boolean;
    };
    child.stdin = new EventedWritable();
    child.stdout = null;
    child.stderr = new EventEmitter();
    child.kill = () => {
      throw new Error("kill C:\\Users\\private\\secret-codex.exe failed");
    };
    spawnMock.mockReturnValueOnce(child);

    expect(() => spawnStdioJsonlTransport(
      "C:\\Users\\private\\secret-codex.exe",
      ["app-server", "--stdio"],
    )).toThrow(new AppServerTransportError("APP_SERVER_PROCESS_STREAMS_UNAVAILABLE"));
    expect(() => child.emit(
      "error",
      new Error("spawn C:\\Users\\private\\secret-codex.exe ENOENT"),
    )).not.toThrow();
  });

  it("turns a child spawn error into one replayable fixed terminal event", async () => {
    const child = new EventedSpawnedProcess();
    spawnMock.mockReturnValueOnce(child);
    const transport = spawnStdioJsonlTransport(
      "C:\\Users\\private\\secret-codex.exe",
      ["app-server", "--stdio"],
    );
    const early: Array<{ code: number | null; signal: string | null }> = [];
    const late: Array<{ code: number | null; signal: string | null }> = [];
    transport.onExit((event) => early.push(event));

    expect(() => child.emit(
      "error",
      new Error("spawn C:\\Users\\private\\secret-codex.exe ENOENT"),
    )).not.toThrow();
    transport.onExit((event) => late.push(event));

    expect(early).toEqual([{ code: null, signal: null }]);
    expect(late).toEqual([{ code: null, signal: null }]);
    expect(JSON.stringify({ early, late })).not.toMatch(/Users|secret-codex|ENOENT/u);

    const closing = transport.close();
    expect(child.killed).toBe(true);
    child.emit("exit", null, "SIGTERM");
    await expect(closing).resolves.toBeUndefined();
  });

  it.each(["stdin", "stdout", "stderr"] as const)(
    "turns a %s stream error into one fixed terminal event",
    async (streamName) => {
      const child = new EventedSpawnedProcess();
      spawnMock.mockReturnValueOnce(child);
      const transport = spawnStdioJsonlTransport(
        "C:\\Users\\private\\secret-codex.exe",
        ["app-server", "--stdio"],
      );
      const terminal: Array<{ code: number | null; signal: string | null }> = [];
      transport.onExit((event) => terminal.push(event));

      expect(() => child[streamName].emit(
        "error",
        new Error("stream C:\\Users\\private\\secret-codex.exe failed"),
      )).not.toThrow();

      expect(terminal).toEqual([{ code: null, signal: null }]);
      expect(JSON.stringify(terminal)).not.toMatch(/Users|secret-codex|failed/u);

      const closing = transport.close();
      expect(child.killed).toBe(true);
      child.emit("exit", null, "SIGTERM");
      await expect(closing).resolves.toBeUndefined();
    },
  );

  it("frames stdout across chunks and writes exactly one JSONL line", () => {
    const child = new FakeSpawnedProcess();
    const transport = new StdioJsonlTransport(child);
    const lines: string[] = [];
    transport.onLine((line) => lines.push(line));

    child.stdout.emit('{"id":1,"res');
    child.stdout.emit('ult":{}}\r\n{"id":2');
    child.stdout.emit(',"result":{}}\n');
    transport.writeLine('{"method":"initialize"}');

    expect(lines).toEqual(['{"id":1,"result":{}}', '{"id":2,"result":{}}']);
    expect(child.stdin.writes).toEqual(['{"method":"initialize"}\n']);
  });

  it("never exposes raw stderr and terminates the child on close", async () => {
    const child = new FakeSpawnedProcess();
    const transport = new StdioJsonlTransport(child);
    const stdout: string[] = [];
    const diagnostics: StructuredDiagnostic[] = [];
    transport.onLine((line) => stdout.push(line));
    transport.onDiagnostic((diagnostic) => diagnostics.push(diagnostic));
    child.stderr.emit("thr_secret C:\\Users\\private question\n");
    child.stderr.emit("codex-cli 0.151.0-alpha.7.2\n");

    const closing = transport.close();
    let settled = false;
    void closing.then(() => { settled = true; });
    await Promise.resolve();

    expect(settled).toBe(false);
    child.exit(0);
    await closing;

    expect(stdout).toEqual([]);
    expect(diagnostics).toEqual([
      {
        code: "APP_SERVER_VERSION",
        component: "app-server",
        version: "0.151.0-alpha.7.2",
        retryable: false,
      },
    ]);
    expect(JSON.stringify(diagnostics)).not.toContain("thr_secret");
    expect(child.stdin.ended).toBe(true);
    expect(child.killed).toBe(true);
  });

  it("resolves immediately without killing when the child already exited", async () => {
    const child = new FakeSpawnedProcess();
    const transport = new StdioJsonlTransport(child);
    child.exit(0);

    await expect(transport.close()).resolves.toBeUndefined();
    expect(child.stdin.ended).toBe(true);
    expect(child.killed).toBe(false);
  });

  it.each([
    { name: "kill returned false", prepare: (child: FakeSpawnedProcess) => { child.killResult = false; } },
    {
      name: "kill threw",
      prepare: (child: FakeSpawnedProcess) => {
        child.killFailure = new Error("thr_secret C:\\Users\\private excerpt");
      },
    },
  ])("rejects with one fixed bounded close error when $name", async ({ prepare }) => {
    const child = new FakeSpawnedProcess();
    prepare(child);
    const transport = new StdioJsonlTransport(child, { closeTimeoutMs: 1 });

    const first = transport.close();
    const second = transport.close();
    await expect(first).rejects.toEqual(new AppServerTransportError("APP_SERVER_CLOSE_TIMEOUT"));
    await expect(second).rejects.toEqual(new AppServerTransportError("APP_SERVER_CLOSE_TIMEOUT"));
    expect(String(await first.catch((error: unknown) => (error as Error).message)))
      .not.toMatch(/thr_secret|Users|private excerpt/u);
  });

  it("does not let JsonlRpcClient swallow a bounded child close timeout", async () => {
    const child = new FakeSpawnedProcess();
    child.killResult = false;
    const transport = new StdioJsonlTransport(child, { closeTimeoutMs: 1 });
    const client = new JsonlRpcClient(transport);

    const first = client.close();
    const second = client.close();

    await expect(first).rejects.toEqual(
      new AppServerTransportError("APP_SERVER_CLOSE_TIMEOUT"),
    );
    await expect(second).rejects.toEqual(
      new AppServerTransportError("APP_SERVER_CLOSE_TIMEOUT"),
    );
    expect(child.killed).toBe(true);
  });
});
