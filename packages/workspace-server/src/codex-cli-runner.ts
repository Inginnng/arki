import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, realpath, readdir, rm, stat, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";

const DEFAULT_TIMEOUT_MS = 180_000;
const MAX_PROCESS_OUTPUT_BYTES = 2 * 1_024 * 1_024;
const MAX_MODEL_OUTPUT_BYTES = 1 * 1_024 * 1_024;
const CODEX_ENVIRONMENT_ALLOWLIST = new Set([
  "ALL_PROXY",
  "APPDATA",
  "CODEX_HOME",
  "COMSPEC",
  "HOME",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "LOCALAPPDATA",
  "NODE_EXTRA_CA_CERTS",
  "NO_PROXY",
  "PATH",
  "PATHEXT",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
  "SYSTEMROOT",
  "TEMP",
  "TMP",
  "TMPDIR",
  "USERPROFILE",
  "WINDIR",
]);
const SAFE_CODEX_EVENT_TYPES = new Set([
  "error",
  "thread.started",
  "turn.completed",
  "turn.failed",
  "turn.started",
]);
const SAFE_CODEX_ITEM_TYPES = new Set(["agent_message", "error", "reasoning"]);

export type StructuredAgentTurn = Readonly<{
  developerInstructions: string;
  text: string;
  outputSchema: unknown;
}>;

export interface StructuredAgentRunner {
  readonly name: string;
  runStructured(turn: StructuredAgentTurn, signal?: AbortSignal): Promise<unknown>;
}

export type CodexExecutionRequest = Readonly<{
  executablePath: string;
  args: readonly string[];
  cwd: string;
  stdin: string;
  outputFile: string;
  timeoutMs: number;
  signal?: AbortSignal;
}>;

export type CodexExecutionResult = Readonly<{
  exitCode: number;
  stdout: string;
  stderr: string;
}>;

export type CodexProcessExecutor = (
  request: CodexExecutionRequest,
) => Promise<CodexExecutionResult>;

export class CodexCliRunnerError extends Error {
  constructor(readonly code:
    | "CODEX_CANCELLED"
    | "CODEX_TIMEOUT"
    | "CODEX_PROCESS_FAILED"
    | "CODEX_OUTPUT_INVALID"
    | "CODEX_TOOL_ISOLATION_BROKEN") {
    super(code);
    this.name = "CodexCliRunnerError";
  }
}

export function codexChildEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source)) {
    if (value !== undefined && CODEX_ENVIRONMENT_ALLOWLIST.has(name.toUpperCase())) {
      environment[name] = value;
    }
  }
  environment.NO_COLOR = "1";
  return environment;
}

export function inspectCodexJsonlEvent(line: string): void {
  if (line.trim().length === 0) return;
  let event: unknown;
  try {
    event = JSON.parse(line);
  } catch {
    throw new CodexCliRunnerError("CODEX_PROCESS_FAILED");
  }
  if (typeof event !== "object" || event === null || Array.isArray(event)) {
    throw new CodexCliRunnerError("CODEX_PROCESS_FAILED");
  }
  const type = Reflect.get(event, "type");
  if (typeof type !== "string") throw new CodexCliRunnerError("CODEX_PROCESS_FAILED");
  if (type.startsWith("item.")) {
    const item = Reflect.get(event, "item");
    const itemType = typeof item === "object" && item !== null && !Array.isArray(item)
      ? Reflect.get(item, "type")
      : undefined;
    if (typeof itemType !== "string" || !SAFE_CODEX_ITEM_TYPES.has(itemType)) {
      throw new CodexCliRunnerError("CODEX_TOOL_ISOLATION_BROKEN");
    }
    return;
  }
  if (!SAFE_CODEX_EVENT_TYPES.has(type)) {
    throw new CodexCliRunnerError("CODEX_TOOL_ISOLATION_BROKEN");
  }
}

function appendBounded(chunks: Buffer[], chunk: Buffer, current: number): number {
  const next = current + chunk.byteLength;
  if (next > MAX_PROCESS_OUTPUT_BYTES) throw new CodexCliRunnerError("CODEX_PROCESS_FAILED");
  chunks.push(chunk);
  return next;
}

async function executeCodexProcess(request: CodexExecutionRequest): Promise<CodexExecutionResult> {
  if (request.signal?.aborted) throw new CodexCliRunnerError("CODEX_CANCELLED");
  return await new Promise<CodexExecutionResult>((resolve, reject) => {
    const child = spawn(request.executablePath, [...request.args], {
      cwd: request.cwd,
      env: codexChildEnvironment(),
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let pendingStdout = Buffer.alloc(0);
    let settled = false;
    let timedOut = false;

    const finish = (operation: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request.signal?.removeEventListener("abort", abort);
      operation();
    };
    const fail = (error: unknown) => {
      if (settled) return;
      child.kill();
      finish(() => reject(error));
    };
    const abort = () => fail(new CodexCliRunnerError("CODEX_CANCELLED"));
    const timer = setTimeout(() => {
      timedOut = true;
      fail(new CodexCliRunnerError("CODEX_TIMEOUT"));
    }, request.timeoutMs);

    request.signal?.addEventListener("abort", abort, { once: true });
    child.once("error", () => fail(new CodexCliRunnerError("CODEX_PROCESS_FAILED")));
    child.stdout.on("data", (value: Buffer | string) => {
      try {
        const chunk = Buffer.from(value);
        stdoutBytes = appendBounded(stdout, chunk, stdoutBytes);
        pendingStdout = Buffer.concat([pendingStdout, chunk]);
        let newline = pendingStdout.indexOf(0x0a);
        while (newline >= 0) {
          inspectCodexJsonlEvent(pendingStdout.subarray(0, newline).toString("utf8").replace(/\r$/, ""));
          pendingStdout = pendingStdout.subarray(newline + 1);
          newline = pendingStdout.indexOf(0x0a);
        }
      } catch (error) {
        fail(error);
      }
    });
    child.stderr.on("data", (value: Buffer | string) => {
      try { stderrBytes = appendBounded(stderr, Buffer.from(value), stderrBytes); } catch (error) { fail(error); }
    });
    child.once("close", (code) => {
      if (settled) return;
      try {
        if (pendingStdout.byteLength > 0) inspectCodexJsonlEvent(pendingStdout.toString("utf8"));
      } catch (error) {
        finish(() => reject(error));
        return;
      }
      finish(() => {
        if (timedOut) return;
        resolve({
          exitCode: code ?? -1,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
        });
      });
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(request.stdin, "utf8");
  });
}

export type CodexCliRunnerOptions = Readonly<{
  executablePath: string;
  execute?: CodexProcessExecutor;
  timeoutMs?: number;
}>;

export class CodexCliRunner implements StructuredAgentRunner {
  readonly name = "codex-cli";
  readonly #execute: CodexProcessExecutor;
  readonly #timeoutMs: number;

  constructor(readonly options: CodexCliRunnerOptions) {
    if (!isAbsolute(options.executablePath) || options.executablePath.includes("\0")) {
      throw new CodexCliRunnerError("CODEX_PROCESS_FAILED");
    }
    this.#execute = options.execute ?? executeCodexProcess;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs < 1_000 || this.#timeoutMs > 600_000) {
      throw new CodexCliRunnerError("CODEX_PROCESS_FAILED");
    }
  }

  async runStructured(turn: StructuredAgentTurn, signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) throw new CodexCliRunnerError("CODEX_CANCELLED");
    const directory = await mkdtemp(join(tmpdir(), "aimd-codex-worker-"));
    const schemaFile = join(directory, "output-schema.json");
    const outputFile = join(directory, "last-message.json");
    try {
      await Promise.all([
        writeFile(join(directory, "AGENTS.md"), `# AIMD Reader model worker\n\n${turn.developerInstructions}\n`, "utf8"),
        writeFile(schemaFile, JSON.stringify(turn.outputSchema), "utf8"),
      ]);
      const args = [
        "exec",
        "--strict-config",
        "-c", 'approval_policy="never"',
        "-c", 'web_search="disabled"',
        "-c", "analytics.enabled=false",
        "-c", "apps._default.enabled=false",
        "-c", 'shell_environment_policy.inherit="none"',
        "-c", "shell_environment_policy.ignore_default_excludes=false",
        "--sandbox", "read-only",
        "--cd", directory,
        "--skip-git-repo-check",
        "--ephemeral",
        "--ignore-user-config",
        "--ignore-rules",
        "--output-schema", schemaFile,
        "--output-last-message", outputFile,
        "--json",
        "--color", "never",
        "-",
      ] as const;
      const result = await this.#execute({
        executablePath: this.options.executablePath,
        args,
        cwd: directory,
        stdin: `${turn.developerInstructions}\n\n--- UNTRUSTED INPUT DATA ---\n${turn.text}`,
        outputFile,
        timeoutMs: this.#timeoutMs,
        ...(signal === undefined ? {} : { signal }),
      });
      if (result.exitCode !== 0) throw new CodexCliRunnerError("CODEX_PROCESS_FAILED");
      const info = await stat(outputFile).catch(() => undefined);
      if (!info?.isFile() || info.size < 2 || info.size > MAX_MODEL_OUTPUT_BYTES) {
        throw new CodexCliRunnerError("CODEX_OUTPUT_INVALID");
      }
      try {
        return JSON.parse(await readFile(outputFile, "utf8"));
      } catch {
        throw new CodexCliRunnerError("CODEX_OUTPUT_INVALID");
      }
    } finally {
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

async function executableCandidate(path: string): Promise<string | undefined> {
  if (!isAbsolute(path) || path.includes("\0")) return undefined;
  try {
    await access(path, process.platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK);
    const canonical = await realpath(path);
    return (await stat(canonical)).isFile() ? canonical : undefined;
  } catch {
    return undefined;
  }
}

async function windowsCodexCandidates(): Promise<string[]> {
  const candidates: string[] = [];
  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData) {
    const binRoot = join(localAppData, "OpenAI", "Codex", "bin");
    const entries = await readdir(binRoot, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.isDirectory()) candidates.push(join(binRoot, entry.name, "codex.exe"));
    }
  }
  for (const directory of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    candidates.push(join(directory, "codex.exe"));
    candidates.push(join(
      directory,
      "node_modules", "@openai", "codex", "node_modules", "@openai", "codex-win32-x64",
      "vendor", "x86_64-pc-windows-msvc", "bin", "codex.exe",
    ));
    candidates.push(join(
      directory,
      "node_modules", "@openai", "codex", "node_modules", "@openai", "codex-win32-arm64",
      "vendor", "aarch64-pc-windows-msvc", "bin", "codex.exe",
    ));
  }
  return candidates;
}

export async function resolveCodexCliExecutable(explicitPath?: string): Promise<string> {
  const candidates = explicitPath
    ? [explicitPath]
    : process.platform === "win32"
      ? await windowsCodexCandidates()
      : (process.env.PATH ?? "").split(delimiter).filter(Boolean).map((directory) => join(directory, "codex"));
  for (const candidate of candidates) {
    const executable = await executableCandidate(candidate);
    if (executable) return executable;
  }
  throw new CodexCliRunnerError("CODEX_PROCESS_FAILED");
}
