import { spawnSync } from "node:child_process";
import { stat, realpath as resolveRealpath } from "node:fs/promises";
import { posix, win32 } from "node:path";

export type ExecutableSource = "environment" | "verified_host_hint" | "path";
export type ExecutableTrust = "operator_explicit" | "verified_host" | "development_path";

const MAX_PATH_BYTES = 32 * 1_024;
const MAX_PATHEXT_BYTES = 4 * 1_024;
const MAX_PATH_EXECUTABLE_CANDIDATES = 32;
const MAX_EXECUTABLE_PATH_LENGTH = 32_767;

export type ExecutableUnavailableCode =
  | "CODEX_BINARY_MISSING"
  | "CODEX_BINARY_NOT_ABSOLUTE"
  | "CODEX_BINARY_INVALID"
  | "CODEX_VERSION_UNAVAILABLE"
  | "CODEX_HOST_HINT_VERSION_MISMATCH"
  | "CODEX_DESKTOP_VERSION_MISMATCH"
  | "CODEX_PATH_UNTRUSTED_FOR_EXACT_CONTEXT"
  | "CODEX_BINARY_UNTRUSTED_PATH"
  | "CODEX_APP_SERVER_INCOMPATIBLE";

export type ExecutableResolution =
  | {
      status: "resolved";
      source: ExecutableSource;
      executablePath: string;
      executableBasename: "codex" | "codex.exe";
      version: string;
      desktopCompatibility: "matched" | "not_provided";
      /** Present on resolver-produced values; optional for legacy constructed fixtures. */
      trust?: ExecutableTrust;
      /** PATH discovery is development-only and never exact-context eligible. */
      exactContextEligible?: boolean;
    }
  | {
      status: "unavailable";
      code: ExecutableUnavailableCode;
      retryable: false;
      resolvedVersion?: string;
      expectedVersion?: string;
    };

export interface ExecutableResolverOptions {
  env: Readonly<Record<string, string | undefined>>;
  verifiedHostHint?: {
    path: string;
    version?: string;
    verified: boolean;
  };
  desktopVersion?: string;
  /** Roots whose contents must never supply a PATH-discovered executable. */
  untrustedRoots?: readonly string[];
}

export interface ExecutableResolverDependencies {
  platform: NodeJS.Platform;
  isFile(candidate: string): Promise<boolean>;
  realpath(candidate: string): Promise<string>;
  findOnPath(
    command: "codex",
    env?: Readonly<Record<string, string | undefined>>,
  ): Promise<string | null>;
  /** Ordered PATH candidates. Older injected adapters may omit this. */
  findAllOnPath?(
    command: "codex",
    env?: Readonly<Record<string, string | undefined>>,
  ): Promise<readonly string[]>;
  run(executable: string, args: readonly string[]): Promise<{ status: number | null; stdout: string }>;
}

function absoluteFor(platform: NodeJS.Platform, candidate: string): boolean {
  return platform === "win32" ? win32.isAbsolute(candidate) : posix.isAbsolute(candidate);
}

function basenameFor(platform: NodeJS.Platform, candidate: string): string {
  return platform === "win32" ? win32.basename(candidate) : posix.basename(candidate);
}

type OwnEnvironmentValue =
  | { status: "absent" }
  | { status: "value"; value: string | undefined }
  | { status: "invalid" };

function inspectOwnEnvironmentValue(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  caseInsensitive: boolean,
): OwnEnvironmentValue {
  let keys: string[];
  try {
    keys = caseInsensitive
      ? Object.getOwnPropertyNames(env).filter((key) => key.toLowerCase() === name.toLowerCase())
      : Object.prototype.hasOwnProperty.call(env, name)
        ? [name]
        : [];
  } catch {
    return { status: "invalid" };
  }
  if (keys.length === 0) return { status: "absent" };
  if (keys.length !== 1) return { status: "invalid" };

  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(env, keys[0]!);
  } catch {
    return { status: "invalid" };
  }
  if (!descriptor || !("value" in descriptor)) return { status: "invalid" };
  if (descriptor.value !== undefined && typeof descriptor.value !== "string") {
    return { status: "invalid" };
  }
  return { status: "value", value: descriptor.value as string | undefined };
}

function envValue(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  caseInsensitive: boolean,
): string | undefined {
  const inspected = inspectOwnEnvironmentValue(env, name, caseInsensitive);
  return inspected.status === "value" ? inspected.value : undefined;
}

function boundedPath(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= MAX_EXECUTABLE_PATH_LENGTH &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

/** Enumerates names directly from PATH/PATHEXT; it never launches where/which or a shell. */
export function enumeratePathExecutableCandidates(
  platform: NodeJS.Platform,
  command: "codex",
  env: Readonly<Record<string, string | undefined>>,
): string[] {
  const windows = platform === "win32";
  const pathValue = envValue(env, "PATH", windows);
  if (!pathValue || Buffer.byteLength(pathValue, "utf8") > MAX_PATH_BYTES) return [];

  const pathApi = windows ? win32 : posix;
  const extensions = [""];
  if (windows) {
    const pathExtValue = envValue(env, "PATHEXT", true) ?? ".COM;.EXE;.BAT;.CMD";
    if (Buffer.byteLength(pathExtValue, "utf8") > MAX_PATHEXT_BYTES) return [];
    const seenExtensions = new Set<string>();
    for (const extension of pathExtValue.split(";")) {
      const trimmed = extension.trim();
      const key = trimmed.toLowerCase();
      if (key !== ".exe" || seenExtensions.has(key)) continue;
      seenExtensions.add(key);
      extensions.push(trimmed);
    }
  }

  const candidates: string[] = [];
  const seen = new Set<string>();
  for (const rawDirectory of pathValue.split(pathApi.delimiter)) {
    const directory = rawDirectory.trim();
    if (!boundedPath(directory) || !pathApi.isAbsolute(directory)) continue;
    for (const extension of extensions) {
      const candidate = pathApi.join(directory, `${command}${extension}`);
      if (!boundedPath(candidate)) continue;
      const key = windows ? candidate.toLowerCase() : candidate;
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push(candidate);
      if (candidates.length >= MAX_PATH_EXECUTABLE_CANDIDATES) return candidates;
    }
  }
  return candidates;
}

function unavailable(
  code: ExecutableUnavailableCode,
  versions?: { resolvedVersion?: string; expectedVersion?: string },
): ExecutableResolution {
  return {
    status: "unavailable",
    code,
    retryable: false,
    ...(versions?.resolvedVersion ? { resolvedVersion: versions.resolvedVersion } : {}),
    ...(versions?.expectedVersion ? { expectedVersion: versions.expectedVersion } : {}),
  };
}

export function parseCodexVersionOutput(stdout: string): string | undefined {
  return /(?:^|\s)codex-cli\s+([0-9A-Za-z][0-9A-Za-z.+-]{0,63})(?:\s|$)/u.exec(stdout)?.[1];
}

function candidateKey(platform: NodeJS.Platform, candidate: string): string {
  return platform === "win32" ? candidate.toLowerCase() : candidate;
}

function containedByRoot(platform: NodeJS.Platform, root: string, candidate: string): boolean {
  const pathApi = platform === "win32" ? win32 : posix;
  if (!pathApi.isAbsolute(root) || !pathApi.isAbsolute(candidate)) return false;
  const comparableRoot = platform === "win32" ? root.toLowerCase() : root;
  const comparableCandidate = platform === "win32" ? candidate.toLowerCase() : candidate;
  const relative = pathApi.relative(comparableRoot, comparableCandidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${pathApi.sep}`) && relative !== ".." && !pathApi.isAbsolute(relative))
  );
}

export const defaultExecutableResolverDependencies: ExecutableResolverDependencies = {
  platform: process.platform,
  async isFile(candidate) {
    try {
      return (await stat(candidate)).isFile();
    } catch {
      return false;
    }
  },
  realpath: resolveRealpath,
  async findOnPath(command, env = process.env) {
    return enumeratePathExecutableCandidates(process.platform, command, env)[0] ?? null;
  },
  async findAllOnPath(command, env = process.env) {
    return enumeratePathExecutableCandidates(process.platform, command, env);
  },
  async run(executable, args) {
    const result = spawnSync(executable, [...args], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 15_000,
      maxBuffer: 64 * 1_024,
    });
    return {
      status: result.status,
      stdout: typeof result.stdout === "string" ? result.stdout : "",
    };
  },
};

async function resolveCandidate(
  source: ExecutableSource,
  candidate: string,
  options: ExecutableResolverOptions,
  dependencies: ExecutableResolverDependencies,
  untrustedRoots: readonly string[] = [],
): Promise<ExecutableResolution> {
  if (!absoluteFor(dependencies.platform, candidate)) {
    return unavailable("CODEX_BINARY_NOT_ABSOLUTE");
  }
  if (
    source === "path" &&
    untrustedRoots.some((root) => containedByRoot(dependencies.platform, root, candidate))
  ) {
    return unavailable("CODEX_BINARY_UNTRUSTED_PATH");
  }
  if (!(await dependencies.isFile(candidate))) {
    return unavailable("CODEX_BINARY_INVALID");
  }

  let executablePath: string;
  try {
    executablePath = await dependencies.realpath(candidate);
  } catch {
    return unavailable("CODEX_BINARY_INVALID");
  }
  if (!absoluteFor(dependencies.platform, executablePath)) {
    return unavailable("CODEX_BINARY_NOT_ABSOLUTE");
  }
  if (source === "path") {
    for (const root of untrustedRoots) {
      let canonicalRoot = root;
      try {
        canonicalRoot = await dependencies.realpath(root);
      } catch {
        // Lexical containment was already checked; an unavailable root adds no authority.
      }
      if (containedByRoot(dependencies.platform, canonicalRoot, executablePath)) {
        return unavailable("CODEX_BINARY_UNTRUSTED_PATH");
      }
    }
  }

  const base = basenameFor(dependencies.platform, executablePath).toLowerCase();
  if (base !== "codex" && base !== "codex.exe") {
    return unavailable("CODEX_BINARY_INVALID");
  }

  const versionProbe = await dependencies.run(executablePath, ["--version"]);
  const version = versionProbe.status === 0 ? parseCodexVersionOutput(versionProbe.stdout) : undefined;
  if (!version) return unavailable("CODEX_VERSION_UNAVAILABLE");

  if (
    source === "verified_host_hint" &&
    options.verifiedHostHint?.version &&
    options.verifiedHostHint.version !== version
  ) {
    return unavailable("CODEX_HOST_HINT_VERSION_MISMATCH", {
      resolvedVersion: version,
      expectedVersion: options.verifiedHostHint.version,
    });
  }
  if (options.desktopVersion && options.desktopVersion !== version) {
    return unavailable("CODEX_DESKTOP_VERSION_MISMATCH", {
      resolvedVersion: version,
      expectedVersion: options.desktopVersion,
    });
  }

  const appServerProbe = await dependencies.run(executablePath, ["app-server", "--help"]);
  if (
    appServerProbe.status !== 0 ||
    !/(?:^|\s)generate-ts(?:\s|$)/u.test(appServerProbe.stdout)
  ) {
    return unavailable("CODEX_APP_SERVER_INCOMPATIBLE", { resolvedVersion: version });
  }

  return {
    status: "resolved",
    source,
    executablePath,
    executableBasename: base as "codex" | "codex.exe",
    version,
    desktopCompatibility: options.desktopVersion ? "matched" : "not_provided",
    trust: source === "environment"
      ? "operator_explicit"
      : source === "verified_host_hint"
        ? "verified_host"
        : "development_path",
    exactContextEligible: source !== "path",
  };
}

export async function resolveCodexExecutable(
  options: ExecutableResolverOptions,
  dependencies: ExecutableResolverDependencies = defaultExecutableResolverDependencies,
): Promise<ExecutableResolution> {
  const explicit = inspectOwnEnvironmentValue(
    options.env,
    "AIMD_CODEX_BIN",
    dependencies.platform === "win32",
  );

  if (explicit.status === "invalid") return unavailable("CODEX_BINARY_INVALID");
  if (explicit.status === "value" && explicit.value !== undefined) {
    if (explicit.value.trim().length === 0) return unavailable("CODEX_BINARY_INVALID");
    return await resolveCandidate("environment", explicit.value, options, dependencies);
  }
  if (options.verifiedHostHint?.verified === true) {
    return await resolveCandidate(
      "verified_host_hint",
      options.verifiedHostHint.path,
      options,
      dependencies,
    );
  }

  if (options.desktopVersion !== undefined) {
    return unavailable("CODEX_PATH_UNTRUSTED_FOR_EXACT_CONTEXT");
  }

  const discovered = dependencies.findAllOnPath
    ? await dependencies.findAllOnPath("codex", options.env)
    : [await dependencies.findOnPath("codex", options.env)].filter(
        (candidate): candidate is string => candidate !== null,
      );
  const candidates: string[] = [];
  const seen = new Set<string>();
  for (const candidate of discovered) {
    if (typeof candidate !== "string" || candidates.length >= MAX_PATH_EXECUTABLE_CANDIDATES) break;
    const key = candidateKey(dependencies.platform, candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push(candidate);
  }
  if (candidates.length === 0) return unavailable("CODEX_BINARY_MISSING");

  const untrustedRoots = options.untrustedRoots ?? [process.cwd()];
  let firstFailure: Extract<ExecutableResolution, { status: "unavailable" }> | undefined;
  for (const candidate of candidates) {
    const result = await resolveCandidate(
      "path",
      candidate,
      options,
      dependencies,
      untrustedRoots,
    );
    if (result.status === "resolved") return result;
    firstFailure ??= result;
  }
  return firstFailure ?? unavailable("CODEX_BINARY_MISSING");
}
