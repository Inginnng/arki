import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import { win32 } from "node:path";
import { fileURLToPath } from "node:url";

export const MAX_SAFE_WRITE_CONTENT_BYTES = 2 * 1_024 * 1_024;
export const MAX_SAFE_WRITE_STDIN_BYTES = 3 * 1_024 * 1_024;
const MAX_SAFE_WRITE_STDOUT_BYTES = 4 * 1_024;
const MAX_SAFE_WRITE_HELPER_BYTES = 256 * 1_024;
const MAX_SAFE_WRITE_PATH_CODE_UNITS = 4_096;
const DEFAULT_SAFE_WRITE_TIMEOUT_MS = 15_000;
const WINDOWS_HELPER_CAPABILITY = "windows_locked_chain_create_new_v1" as const;

declare const __AIMD_SAFE_WRITE_HELPER_SHA256__: string | undefined;
const BUILD_INJECTED_HELPER_SHA256 =
  typeof __AIMD_SAFE_WRITE_HELPER_SHA256__ === "string"
    ? __AIMD_SAFE_WRITE_HELPER_SHA256__
    : "";
export const PACKAGED_SAFE_WRITE_HELPER_SHA256 =
  /^[a-f0-9]{64}$/u.test(BUILD_INJECTED_HELPER_SHA256)
    ? BUILD_INJECTED_HELPER_SHA256
    : "";

export type SafeOutputWriteErrorCode =
  | "SAFE_WRITE_UNAVAILABLE"
  | "SAFE_WRITE_INPUT_TOO_LARGE"
  | "SAFE_WRITE_INPUT_INVALID"
  | "UNSAFE_OUTPUT_PATH_CHANGED"
  | "OUTPUT_ALREADY_EXISTS";

export class SafeOutputWriteError extends Error {
  readonly code: SafeOutputWriteErrorCode;

  constructor(code: SafeOutputWriteErrorCode) {
    super(code);
    this.name = "SafeOutputWriteError";
    this.code = code;
  }
}

export type SafeOutputSourceDescriptor = Readonly<{
  canonicalRoot: string;
  canonicalSourcePath: string;
  sourceContentSha256: string;
}>;

export type SafeWriteResult = Readonly<{
  targetBasename: string;
  byteLength: number;
}>;

export type SafeWriteCapability =
  | Readonly<{
      status: "available";
      capability: typeof WINDOWS_HELPER_CAPABILITY;
    }>
  | Readonly<{
      status: "unavailable";
      code: "SAFE_WRITE_UNAVAILABLE";
    }>;

export type SafeWriteHelperInvocation = Readonly<{
  executablePath: string;
  args: readonly string[];
  stdin: string;
  shell: false;
  windowsHide: true;
  timeoutMs: number;
  maxStdoutBytes: number;
}>;

export type SafeWriteHelperProcessResult = Readonly<{
  exitCode: number | null;
  stdout: string;
}>;

export type InspectedOrdinaryFile = Readonly<{
  canonicalPath: string;
  ordinaryFile: boolean;
  size?: number;
}>;

export interface SafeWriterDependencies {
  readonly platform: NodeJS.Platform;
  inspectOrdinaryFile(path: string): Promise<InspectedOrdinaryFile>;
  readFileBytes(path: string): Promise<Uint8Array>;
  runHelper(invocation: SafeWriteHelperInvocation): Promise<SafeWriteHelperProcessResult>;
}

export type SafeOutputWriterOptions = Readonly<{
  powershellExecutablePath: string;
  helperScriptPath: string;
  expectedHelperSha256: string;
  timeoutMs?: number;
}>;

export type PackagedSafeOutputWriterOptions = Readonly<{
  /**
   * Literal executable selected by the trusted desktop host. Never populate
   * this from a project file, environment-owned project config, UI, or MCP.
   */
  powershellExecutablePath: string;
  timeoutMs?: number;
}>;

type PreparedHelper = Readonly<{
  executablePath: string;
  helperScriptPath: string;
}>;

type HelperRequest =
  | Readonly<{ version: 1; operation: "probe" }>
  | Readonly<{
      version: 1;
      operation: "create";
      canonicalRoot: string;
      canonicalSourcePath: string;
      sourceContentSha256: string;
      targetBasename: string;
      contentBase64: string;
    }>;

type ParsedHelperResponse =
  | Readonly<{ kind: "capable" }>
  | Readonly<{ kind: "created" }>
  | Readonly<{
      kind: "error";
      code: "SAFE_WRITE_UNAVAILABLE" | "UNSAFE_OUTPUT_PATH_CHANGED" | "OUTPUT_ALREADY_EXISTS";
    }>;

function fixedError(code: SafeOutputWriteErrorCode): SafeOutputWriteError {
  return new SafeOutputWriteError(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return keys.length === sortedExpected.length && keys.every((key, index) => key === sortedExpected[index]);
}

function parseHelperResponse(result: SafeWriteHelperProcessResult): ParsedHelperResponse | null {
  if (
    Buffer.byteLength(result.stdout, "utf8") === 0 ||
    Buffer.byteLength(result.stdout, "utf8") > MAX_SAFE_WRITE_STDOUT_BYTES
  ) return null;

  let raw: unknown;
  try {
    raw = JSON.parse(result.stdout);
  } catch {
    return null;
  }
  if (!isRecord(raw) || raw.version !== 1 || typeof raw.status !== "string") return null;

  if (
    result.exitCode === 0 &&
    raw.status === "created" &&
    exactKeys(raw, ["version", "status"])
  ) return { kind: "created" };

  if (
    result.exitCode === 0 &&
    raw.status === "capable" &&
    raw.capability === WINDOWS_HELPER_CAPABILITY &&
    exactKeys(raw, ["version", "status", "capability"])
  ) return { kind: "capable" };

  if (raw.status !== "error" || typeof raw.code !== "string") return null;
  if (!exactKeys(raw, ["version", "status", "code"])) return null;
  if (raw.code === "OUTPUT_ALREADY_EXISTS" && result.exitCode === 10) {
    return { kind: "error", code: raw.code };
  }
  if (raw.code === "UNSAFE_OUTPUT_PATH_CHANGED" && result.exitCode === 11) {
    return { kind: "error", code: raw.code };
  }
  if (raw.code === "SAFE_WRITE_UNAVAILABLE" && result.exitCode === 12) {
    return { kind: "error", code: raw.code };
  }
  return null;
}

function stripWindowsDevicePrefix(path: string): string {
  if (/^\\\\\?\\UNC\\/iu.test(path)) return `\\\\${path.slice(8)}`;
  if (/^\\\\\?\\[A-Za-z]:\\/u.test(path)) return path.slice(4);
  return path;
}

function normalizedWindowsPath(path: string): string | null {
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    path.length > MAX_SAFE_WRITE_PATH_CODE_UNITS ||
    /[\p{Cc}\p{Cs}]/u.test(path) ||
    /(?:^|[\\/])\.{1,2}(?:[\\/]|$)/u.test(path) ||
    /^\\\\(?:\.|\?\\GLOBALROOT|\?\\Device)\\/iu.test(path)
  ) return null;

  const withoutPrefix = stripWindowsDevicePrefix(path);
  if (!win32.isAbsolute(withoutPrefix)) return null;
  const normalized = win32.normalize(withoutPrefix);
  const drive = /^[A-Za-z]:/u.exec(normalized)?.[0];
  if (normalized.includes(":", drive ? 2 : 0)) return null;
  const parsed = win32.parse(normalized);
  return normalized.length > parsed.root.length
    ? normalized.replace(/[\\/]+$/u, "")
    : normalized;
}

function sameWindowsPath(left: string, right: string): boolean {
  const normalizedLeft = normalizedWindowsPath(left);
  const normalizedRight = normalizedWindowsPath(right);
  return normalizedLeft !== null && normalizedRight !== null &&
    normalizedLeft === normalizedRight;
}

function isInsideWindowsRoot(root: string, candidate: string): boolean {
  if (candidate === root) return false;
  const prefix = root.endsWith(win32.sep) ? root : `${root}${win32.sep}`;
  return candidate.startsWith(prefix);
}

function isSafeWindowsBasename(value: string): boolean {
  if (
    value.length === 0 ||
    value.length > 255 ||
    value === "." ||
    value === ".." ||
    win32.basename(value) !== value ||
    /[\p{Cc}\p{Cs}<>:"/\\|?*]/u.test(value) ||
    /[. ]$/u.test(value)
  ) return false;

  const deviceStem = value.split(".", 1)[0]?.toUpperCase();
  return deviceStem !== undefined &&
    !/^(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[1-9¹²³]|LPT[1-9¹²³])$/u.test(deviceStem);
}

function validateTarget(
  source: SafeOutputSourceDescriptor,
  targetBasename: string,
): {
  canonicalRoot: string;
  canonicalSourcePath: string;
  sourceContentSha256: string;
  targetBasename: string;
} {
  if (
    typeof source !== "object" ||
    source === null ||
    Array.isArray(source) ||
    typeof source.canonicalRoot !== "string" ||
    typeof source.canonicalSourcePath !== "string" ||
    typeof source.sourceContentSha256 !== "string" ||
    typeof targetBasename !== "string"
  ) throw fixedError("UNSAFE_OUTPUT_PATH_CHANGED");
  const canonicalRoot = normalizedWindowsPath(source.canonicalRoot);
  const canonicalSourcePath = normalizedWindowsPath(source.canonicalSourcePath);
  if (
    canonicalRoot === null ||
    canonicalSourcePath === null ||
    !isInsideWindowsRoot(canonicalRoot, canonicalSourcePath) ||
    !/^[a-f0-9]{64}$/u.test(source.sourceContentSha256) ||
    !isSafeWindowsBasename(targetBasename)
  ) throw fixedError("UNSAFE_OUTPUT_PATH_CHANGED");

  const sourceBasename = win32.basename(canonicalSourcePath);
  const sourceExtension = win32.extname(sourceBasename).toLowerCase();
  if (
    (sourceExtension !== ".md" && sourceExtension !== ".markdown") ||
    sourceBasename.length <= sourceExtension.length
  ) {
    throw fixedError("UNSAFE_OUTPUT_PATH_CHANGED");
  }
  const expectedTarget = `${sourceBasename.slice(0, -sourceExtension.length)}.explained.md`;
  if (targetBasename !== expectedTarget) throw fixedError("UNSAFE_OUTPUT_PATH_CHANGED");

  return {
    canonicalRoot,
    canonicalSourcePath,
    sourceContentSha256: source.sourceContentSha256,
    targetBasename,
  };
}

function boundedContent(content: Uint8Array): Uint8Array {
  if (!(content instanceof Uint8Array)) throw fixedError("SAFE_WRITE_INPUT_INVALID");
  if (content.byteLength > MAX_SAFE_WRITE_CONTENT_BYTES) {
    throw fixedError("SAFE_WRITE_INPUT_TOO_LARGE");
  }
  return Uint8Array.from(content);
}

async function defaultInspectOrdinaryFile(path: string): Promise<InspectedOrdinaryFile> {
  try {
    const [info, canonicalPath] = await Promise.all([lstat(path), realpath(path)]);
    return {
      canonicalPath,
      ordinaryFile: info.isFile() && !info.isSymbolicLink(),
      size: info.size,
    };
  } catch {
    return { canonicalPath: "", ordinaryFile: false };
  }
}

async function defaultReadBoundedHelperBytes(path: string): Promise<Uint8Array> {
  const handle = await open(path, "r");
  try {
    const bytes = Buffer.allocUnsafe(MAX_SAFE_WRITE_HELPER_BYTES + 1);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const result = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    return bytes.subarray(0, offset);
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function defaultRunHelper(invocation: SafeWriteHelperInvocation): Promise<SafeWriteHelperProcessResult> {
  if (
    invocation.shell !== false ||
    Buffer.byteLength(invocation.stdin, "utf8") > MAX_SAFE_WRITE_STDIN_BYTES
  ) return Promise.reject(fixedError("SAFE_WRITE_UNAVAILABLE"));

  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(invocation.executablePath, [...invocation.args], {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: invocation.windowsHide,
        shell: false,
      });
    } catch {
      reject(fixedError("SAFE_WRITE_UNAVAILABLE"));
      return;
    }

    const stdin = child.stdin;
    const stdout = child.stdout;
    const stderr = child.stderr;
    if (!stdin || !stdout || !stderr) {
      try {
        child.kill();
      } catch {
        // A missing pipe is already a fixed unavailable result.
      }
      reject(fixedError("SAFE_WRITE_UNAVAILABLE"));
      return;
    }

    let settled = false;
    let stdoutBytes = 0;
    const stdoutChunks: Buffer[] = [];
    const finish = (result?: SafeWriteHelperProcessResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (result) resolve(result);
      else reject(fixedError("SAFE_WRITE_UNAVAILABLE"));
    };
    const stop = (): void => {
      try {
        child.kill();
      } catch {
        // The fixed unavailable result is the only public error authority.
      }
    };
    const timer = setTimeout(() => {
      stop();
      finish();
    }, invocation.timeoutMs);
    const fail = (): void => {
      stop();
      finish();
    };

    child.on("error", fail);
    stdin.on("error", fail);
    stdout.on("error", fail);
    stderr.on("error", fail);
    stdout.on("data", (chunk: Uint8Array | string) => {
      if (settled) return;
      const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk);
      stdoutBytes += bytes.byteLength;
      if (stdoutBytes > invocation.maxStdoutBytes) {
        stop();
        finish();
        return;
      }
      stdoutChunks.push(bytes);
    });
    // stderr may contain paths, content, policy details, or process diagnostics.
    // It is intentionally drained and discarded without entering any result.
    stderr.on("data", () => undefined);
    child.on("close", (exitCode) => {
      finish({ exitCode, stdout: Buffer.concat(stdoutChunks).toString("utf8") });
    });

    try {
      stdin.end(invocation.stdin, "utf8");
    } catch {
      stop();
      finish();
    }
  });
}

export const defaultSafeWriterDependencies: SafeWriterDependencies = {
  platform: process.platform,
  inspectOrdinaryFile: defaultInspectOrdinaryFile,
  readFileBytes: defaultReadBoundedHelperBytes,
  runHelper: defaultRunHelper,
};

export class SafeOutputWriter {
  readonly #timeoutMs: number;

  constructor(
    readonly options: SafeOutputWriterOptions,
    readonly dependencies: SafeWriterDependencies = defaultSafeWriterDependencies,
  ) {
    const timeoutMs = options.timeoutMs ?? DEFAULT_SAFE_WRITE_TIMEOUT_MS;
    this.#timeoutMs = Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 30_000
      ? timeoutMs
      : DEFAULT_SAFE_WRITE_TIMEOUT_MS;
  }

  async capability(): Promise<SafeWriteCapability> {
    const prepared = await this.#prepareHelper();
    if (!prepared) return { status: "unavailable", code: "SAFE_WRITE_UNAVAILABLE" };
    const response = await this.#invoke(prepared, { version: 1, operation: "probe" });
    return response?.kind === "capable"
      ? { status: "available", capability: WINDOWS_HELPER_CAPABILITY }
      : { status: "unavailable", code: "SAFE_WRITE_UNAVAILABLE" };
  }

  async createExplainedSibling(
    source: SafeOutputSourceDescriptor,
    targetBasename: string,
    rawContent: Uint8Array,
  ): Promise<SafeWriteResult> {
    if (this.dependencies.platform !== "win32") throw fixedError("SAFE_WRITE_UNAVAILABLE");
    const target = validateTarget(source, targetBasename);
    const content = boundedContent(rawContent);
    const prepared = await this.#prepareHelper();
    if (!prepared) throw fixedError("SAFE_WRITE_UNAVAILABLE");

    const response = await this.#invoke(prepared, {
      version: 1,
      operation: "create",
      ...target,
      contentBase64: Buffer.from(content).toString("base64"),
    });
    if (!response) throw fixedError("SAFE_WRITE_UNAVAILABLE");
    if (response.kind === "error") throw fixedError(response.code);
    if (response.kind !== "created") throw fixedError("SAFE_WRITE_UNAVAILABLE");
    return { targetBasename, byteLength: content.byteLength };
  }

  async #prepareHelper(): Promise<PreparedHelper | null> {
    if (this.dependencies.platform !== "win32") return null;
    if (!/^[a-f0-9]{64}$/u.test(this.options.expectedHelperSha256)) return null;

    const executablePath = normalizedWindowsPath(this.options.powershellExecutablePath);
    const helperScriptPath = normalizedWindowsPath(this.options.helperScriptPath);
    if (executablePath === null || helperScriptPath === null) return null;
    const executableBasename = win32.basename(executablePath).toLowerCase();
    if (executableBasename !== "powershell.exe" && executableBasename !== "pwsh.exe") return null;
    if (win32.basename(helperScriptPath).toLowerCase() !== "safe-write-windows.ps1") return null;

    try {
      const [executable, helper] = await Promise.all([
        this.dependencies.inspectOrdinaryFile(executablePath),
        this.dependencies.inspectOrdinaryFile(helperScriptPath),
      ]);
      if (
        !executable.ordinaryFile ||
        !helper.ordinaryFile ||
        !sameWindowsPath(executable.canonicalPath, executablePath) ||
        !sameWindowsPath(helper.canonicalPath, helperScriptPath) ||
        (helper.size !== undefined && helper.size > MAX_SAFE_WRITE_HELPER_BYTES)
      ) return null;

      const helperBytes = await this.dependencies.readFileBytes(helperScriptPath);
      if (helperBytes.byteLength > MAX_SAFE_WRITE_HELPER_BYTES) return null;
      const actualHash = createHash("sha256").update(helperBytes).digest("hex");
      if (actualHash !== this.options.expectedHelperSha256) return null;
      return { executablePath, helperScriptPath };
    } catch {
      return null;
    }
  }

  async #invoke(
    prepared: PreparedHelper,
    request: HelperRequest,
  ): Promise<ParsedHelperResponse | null> {
    const stdin = JSON.stringify(request);
    if (Buffer.byteLength(stdin, "utf8") > MAX_SAFE_WRITE_STDIN_BYTES) {
      throw fixedError("SAFE_WRITE_INPUT_TOO_LARGE");
    }
    const invocation: SafeWriteHelperInvocation = {
      executablePath: prepared.executablePath,
      args: [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-File",
        prepared.helperScriptPath,
      ],
      stdin,
      shell: false,
      windowsHide: true,
      timeoutMs: this.#timeoutMs,
      maxStdoutBytes: MAX_SAFE_WRITE_STDOUT_BYTES,
    };
    try {
      return parseHelperResponse(await this.dependencies.runHelper(invocation));
    } catch {
      return null;
    }
  }
}

/**
 * Production construction seam. The helper digest is embedded into the server
 * bundle and its path is pinned beside that bundle. Source/dev runs remain
 * unavailable by default. Integrity of that packaged directory is part of the
 * desktop installation trust boundary.
 */
export function createPackagedSafeOutputWriter(
  options: PackagedSafeOutputWriterOptions,
  dependencies: SafeWriterDependencies = defaultSafeWriterDependencies,
): SafeOutputWriter {
  return new SafeOutputWriter(
    {
      ...options,
      helperScriptPath: fileURLToPath(new URL("./safe-write-windows.ps1", import.meta.url)),
      expectedHelperSha256: PACKAGED_SAFE_WRITE_HELPER_SHA256,
    },
    dependencies,
  );
}
