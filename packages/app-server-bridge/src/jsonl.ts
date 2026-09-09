export type StructuredDiagnostic = {
  code:
    | "APP_SERVER_VERSION"
    | "APP_SERVER_MALFORMED_JSONL"
    | "APP_SERVER_PROTOCOL_ERROR"
    | "APP_SERVER_EXITED";
  component: "app-server" | "jsonl";
  version?: string;
  retryable: boolean;
};

export interface JsonlLineTransport {
  writeLine(line: string): void;
  onLine(listener: (line: string) => void): () => void;
  onExit(listener: (exit: { code: number | null; signal: string | null }) => void): () => void;
  onDiagnostic(listener: (diagnostic: StructuredDiagnostic) => void): () => void;
  close(): void | Promise<void>;
}

interface ReadableChunks {
  on(event: "data", listener: (chunk: Uint8Array | string) => void): unknown;
  on(event: "error", listener: (error: unknown) => void): unknown;
  on(event: "end" | "close", listener: () => void): unknown;
}

export interface SpawnedJsonlProcess {
  stdin: {
    write(chunk: string): boolean;
    end(): void;
    on(event: "error", listener: (error: unknown) => void): unknown;
  };
  stdout: ReadableChunks;
  stderr: ReadableChunks;
  on(
    event: "exit",
    listener: (code: number | null, signal: string | null) => void,
  ): unknown;
  on(event: "error", listener: (error: unknown) => void): unknown;
  kill(): boolean;
}

type StdioJsonlTransportOptions = {
  readonly closeTimeoutMs?: number;
};

class LineFramer {
  private readonly decoder = new StringDecoder("utf8");
  private buffered = "";
  private ended = false;

  constructor(private readonly emit: (line: string) => void) {}

  receive(chunk: Uint8Array | string): void {
    if (this.ended) return;
    this.buffered += typeof chunk === "string" ? chunk : this.decoder.write(Buffer.from(chunk));
    if (Buffer.byteLength(this.buffered, "utf8") > MAX_JSONL_LINE_BYTES) {
      this.buffered = "";
      this.emit("");
      return;
    }
    while (true) {
      const newline = this.buffered.indexOf("\n");
      if (newline < 0) return;
      const line = this.buffered.slice(0, newline).replace(/\r$/u, "");
      this.buffered = this.buffered.slice(newline + 1);
      this.emit(line);
    }
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    this.buffered += this.decoder.end();
    if (this.buffered.length > 0) this.emit(this.buffered.replace(/\r$/u, ""));
    this.buffered = "";
  }

  discard(): void {
    if (this.ended) return;
    this.ended = true;
    this.decoder.end();
    this.buffered = "";
  }
}

export class StdioJsonlTransport implements JsonlLineTransport {
  private readonly lineListeners = new Set<(line: string) => void>();
  private readonly exitListeners = new Set<
    (exit: { code: number | null; signal: string | null }) => void
  >();
  private readonly diagnosticListeners = new Set<
    (diagnostic: StructuredDiagnostic) => void
  >();
  private readonly stdoutFramer = new LineFramer((line) => {
    for (const listener of this.lineListeners) listener(line);
  });
  private readonly stderrFramer = new LineFramer((line) => {
    const diagnostic = sanitizeStderrLine(line);
    if (!diagnostic) return;
    for (const listener of this.diagnosticListeners) listener(diagnostic);
  });
  private closed = false;
  private exited = false;
  private terminalExit?: { code: number | null; signal: string | null };
  private readonly exitPromise: Promise<void>;
  private resolveExit!: () => void;
  private closePromise?: Promise<void>;
  private readonly closeTimeoutMs: number;

  constructor(
    private readonly child: SpawnedJsonlProcess,
    options: StdioJsonlTransportOptions = {},
  ) {
    const closeTimeoutMs = options.closeTimeoutMs ?? 5_000;
    if (!Number.isInteger(closeTimeoutMs) || closeTimeoutMs < 0 || closeTimeoutMs > 30_000) {
      throw new AppServerTransportError("APP_SERVER_CLOSE_TIMEOUT_INVALID");
    }
    this.closeTimeoutMs = closeTimeoutMs;
    this.exitPromise = new Promise((resolve) => {
      this.resolveExit = resolve;
    });
    child.stdout.on("data", (chunk) => this.stdoutFramer.receive(chunk));
    child.stderr.on("data", (chunk) => this.stderrFramer.receive(chunk));
    const transportFailure = () => this.notifyTerminal({ code: null, signal: null });
    const stdoutFailure = () => {
      this.stdoutFramer.discard();
      this.notifyTerminal({ code: null, signal: null });
    };
    const stdoutEnded = () => {
      // stdout is the JSON-RPC response channel. EOF is terminal even when the
      // child has not emitted `exit`. A JSONL fragment without a newline is not
      // a completed frame and must never resolve work during shutdown.
      this.stdoutFramer.discard();
      this.notifyTerminal({ code: null, signal: null });
    };
    child.stdin.on("error", transportFailure);
    child.stdout.on("error", stdoutFailure);
    child.stdout.on("end", stdoutEnded);
    child.stdout.on("close", stdoutEnded);
    child.stderr.on("error", transportFailure);
    child.on("error", transportFailure);
    child.on("exit", (code, signal) => this.finish({ code, signal }));
  }

  writeLine(line: string): void {
    if (this.closed) throw new AppServerTransportError("APP_SERVER_CLOSED");
    if (/\r|\n/u.test(line)) throw new AppServerTransportError("APP_SERVER_LINE_INVALID");
    this.child.stdin.write(`${line}\n`);
  }

  onLine(listener: (line: string) => void): () => void {
    this.lineListeners.add(listener);
    return () => this.lineListeners.delete(listener);
  }

  onExit(listener: (exit: { code: number | null; signal: string | null }) => void): () => void {
    if (this.terminalExit) {
      listener(this.terminalExit);
      return () => undefined;
    }
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  onDiagnostic(listener: (diagnostic: StructuredDiagnostic) => void): () => void {
    this.diagnosticListeners.add(listener);
    return () => this.diagnosticListeners.delete(listener);
  }

  close(): Promise<void> {
    this.closePromise ??= this.closeOnce();
    return this.closePromise;
  }

  private async closeOnce(): Promise<void> {
    this.closed = true;
    try {
      this.child.stdin.end();
    } catch {
      // Exit observation below is the only close authority.
    }
    if (this.exited) return;
    try {
      this.child.kill();
    } catch {
      // Never expose process-authored exception text. The bounded wait emits
      // one fixed error if no exit event follows.
    }
    if (this.exited) return;

    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.exitPromise,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => {
            reject(new AppServerTransportError("APP_SERVER_CLOSE_TIMEOUT"));
          }, this.closeTimeoutMs);
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private finish(exit: { code: number | null; signal: string | null }): void {
    if (this.exited) return;
    this.exited = true;
    this.resolveExit();
    this.stdoutFramer.discard();
    this.stderrFramer.end();
    this.notifyTerminal(exit);
  }

  private notifyTerminal(exit: { code: number | null; signal: string | null }): void {
    if (this.terminalExit) return;
    this.terminalExit = exit;
    for (const listener of this.exitListeners) listener(exit);
  }
}

export function spawnStdioJsonlTransport(
  executablePath: string,
  args: readonly string[],
): StdioJsonlTransport {
  const child = spawn(executablePath, [...args], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    shell: false,
  });
  const discardRawError = () => undefined;
  child.on("error", discardRawError);
  child.stdin?.on("error", discardRawError);
  child.stdout?.on("error", discardRawError);
  child.stderr?.on("error", discardRawError);
  if (!child.stdin || !child.stdout || !child.stderr) {
    try {
      child.kill();
    } catch {
      // The fixed stream-availability error below is the only public result.
    }
    throw new AppServerTransportError("APP_SERVER_PROCESS_STREAMS_UNAVAILABLE");
  }
  return new StdioJsonlTransport(child as unknown as SpawnedJsonlProcess);
}

export class AppServerTransportError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "AppServerTransportError";
    this.code = code;
  }
}

export type JsonlNotification = { method: string; params?: unknown };

type PendingRequest = {
  resolve(value: unknown): void;
  reject(reason: AppServerTransportError): void;
  cleanup(): void;
};

type JsonlRpcClientOptions = {
  onDiagnostic?: (diagnostic: StructuredDiagnostic) => void;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function sanitizeStderrLine(line: string): StructuredDiagnostic | null {
  const match = /^codex-cli (\S{1,64})$/u.exec(line);
  const version = match?.[1];
  if (!version || !STRICT_SEMVER_PATTERN.test(version)) return null;
  return {
    code: "APP_SERVER_VERSION",
    component: "app-server",
    version,
    retryable: false,
  };
}

export class JsonlRpcClient {
  private readonly pending = new Map<string, PendingRequest>();
  private readonly notificationListeners = new Set<(notification: JsonlNotification) => void>();
  private readonly failureListeners = new Set<(error: AppServerTransportError) => void>();
  private readonly unsubscribers: Array<() => void>;
  private nextId = 1;
  private failed = false;
  private transportClosePromise?: Promise<void>;

  constructor(
    private readonly transport: JsonlLineTransport,
    private readonly options: JsonlRpcClientOptions = {},
  ) {
    this.unsubscribers = [
      transport.onLine((line) => this.receiveLine(line)),
      transport.onExit(() => this.failAll("APP_SERVER_EXITED", {
        code: "APP_SERVER_EXITED",
        component: "app-server",
        retryable: true,
      }, true)),
      transport.onDiagnostic((diagnostic) => this.options.onDiagnostic?.(diagnostic)),
    ];
  }

  onNotification(listener: (notification: JsonlNotification) => void): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  onFailure(listener: (error: AppServerTransportError) => void): () => void {
    this.failureListeners.add(listener);
    return () => this.failureListeners.delete(listener);
  }

  notify(method: string, params?: unknown): void {
    if (this.failed) throw new AppServerTransportError("APP_SERVER_UNAVAILABLE");
    try {
      this.transport.writeLine(
        JSON.stringify(params === undefined ? { method } : { method, params }),
      );
    } catch {
      throw new AppServerTransportError("APP_SERVER_WRITE_FAILED");
    }
  }

  request(
    method: string,
    params: unknown,
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<unknown> {
    if (this.failed) return Promise.reject(new AppServerTransportError("APP_SERVER_UNAVAILABLE"));
    if (options.signal?.aborted) {
      return Promise.reject(new AppServerTransportError("APP_SERVER_CANCELLED"));
    }

    const id = this.nextId++;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let abortListener: (() => void) | undefined;

    const promise = new Promise<unknown>((resolve, reject) => {
      const cleanup = () => {
        if (timeout) clearTimeout(timeout);
        if (abortListener && options.signal) {
          options.signal.removeEventListener("abort", abortListener);
        }
      };
      this.pending.set(String(id), {
        resolve,
        reject,
        cleanup,
      });

      abortListener = () => {
        const pending = this.pending.get(String(id));
        if (!pending) return;
        this.pending.delete(String(id));
        pending.cleanup();
        pending.reject(new AppServerTransportError("APP_SERVER_CANCELLED"));
      };
      options.signal?.addEventListener("abort", abortListener, { once: true });

      if (options.timeoutMs !== undefined) {
        timeout = setTimeout(() => {
          if (!this.pending.has(String(id))) return;
          this.failAll("APP_SERVER_TIMEOUT", undefined, true);
        }, options.timeoutMs);
      }
    });

    try {
      this.transport.writeLine(JSON.stringify({ method, id, params }));
    } catch {
      const pending = this.pending.get(String(id));
      if (pending) {
        this.pending.delete(String(id));
        pending.cleanup();
        pending.reject(new AppServerTransportError("APP_SERVER_WRITE_FAILED"));
      }
    }
    return promise;
  }

  async close(): Promise<void> {
    this.failAll("APP_SERVER_CLOSED");
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
    await this.closeTransportOnce();
  }

  private receiveLine(line: string): void {
    if (this.failed) return;

    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      this.failAll("APP_SERVER_MALFORMED_JSONL", {
        code: "APP_SERVER_MALFORMED_JSONL",
        component: "jsonl",
        retryable: false,
      }, true);
      return;
    }

    if (!isRecord(value)) {
      this.failAll("APP_SERVER_PROTOCOL_ERROR", {
        code: "APP_SERVER_PROTOCOL_ERROR",
        component: "jsonl",
        retryable: false,
      }, true);
      return;
    }

    const hasResult = Object.hasOwn(value, "result");
    const hasError = Object.hasOwn(value, "error");
    if (
      (typeof value.id === "number" || typeof value.id === "string") &&
      hasResult &&
      hasError
    ) {
      this.failAll("APP_SERVER_PROTOCOL_ERROR", {
        code: "APP_SERVER_PROTOCOL_ERROR",
        component: "jsonl",
        retryable: false,
      }, true);
      return;
    }

    if (
      (typeof value.id === "number" || typeof value.id === "string") &&
      (hasResult || hasError)
    ) {
      const pending = this.pending.get(String(value.id));
      if (!pending) return;
      this.pending.delete(String(value.id));
      pending.cleanup();
      if (hasError) {
        pending.reject(new AppServerTransportError("APP_SERVER_REQUEST_FAILED"));
      } else {
        pending.resolve(value.result);
      }
      return;
    }

    if (typeof value.method === "string" && !("id" in value)) {
      const notification: JsonlNotification = "params" in value
        ? { method: value.method, params: value.params }
        : { method: value.method };
      for (const listener of this.notificationListeners) listener(notification);
      return;
    }

    this.failAll("APP_SERVER_PROTOCOL_ERROR", {
      code: "APP_SERVER_PROTOCOL_ERROR",
      component: "jsonl",
      retryable: false,
    }, true);
  }

  private closeTransportOnce(): Promise<void> {
    if (!this.transportClosePromise) {
      try {
        this.transportClosePromise = Promise.resolve(this.transport.close()).catch((error) => {
          if (
            error instanceof AppServerTransportError &&
            error.code === "APP_SERVER_CLOSE_TIMEOUT"
          ) {
            throw error;
          }
          throw new AppServerTransportError("APP_SERVER_CLOSE_FAILED");
        });
      } catch {
        this.transportClosePromise = Promise.reject(
          new AppServerTransportError("APP_SERVER_CLOSE_FAILED"),
        );
      }
    }
    return this.transportClosePromise;
  }

  private failAll(
    code: string,
    diagnostic?: StructuredDiagnostic,
    closeTransport = false,
  ): void {
    if (this.failed) return;
    this.failed = true;
    if (diagnostic) this.options.onDiagnostic?.(diagnostic);
    const error = new AppServerTransportError(code);
    for (const listener of this.failureListeners) listener(error);
    for (const pending of this.pending.values()) {
      pending.cleanup();
      pending.reject(error);
    }
    this.pending.clear();
    if (closeTransport) void this.closeTransportOnce().catch(() => undefined);
  }
}
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

const MAX_JSONL_LINE_BYTES = 1_048_576;
const STRICT_SEMVER_PATTERN =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
