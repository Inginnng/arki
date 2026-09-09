import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";

import { z } from "zod";

import { isCanonicalPathContained } from "./canonical-path.js";

export const MAX_DENY_GLOBS = 64;
export const MAX_DENY_GLOB_LENGTH = 256;
export const MAX_DENY_GLOBS_BYTES = 8_192;
export const MIN_RETENTION_DAYS = 1;
export const MAX_RETENTION_DAYS = 3_650;

const DEFAULT_RETENTION_DAYS = 30;
const DEFAULT_DRAFT_RETENTION_DAYS = 90;
const MAX_DATA_DIRECTORY_LENGTH = 4_096;

const AbsoluteDataDirectorySchema = z
  .string()
  .min(1)
  .max(MAX_DATA_DIRECTORY_LENGTH)
  .refine((value) => !value.includes("\0"), "Data directory cannot contain NUL bytes")
  .refine(
    (value) => posix.isAbsolute(value) || win32.isAbsolute(value),
    "Data directory must be absolute",
  );

const DenyGlobSchema = z
  .string()
  .min(1)
  .max(MAX_DENY_GLOB_LENGTH)
  .refine((value) => value.trim().length > 0, "Deny globs cannot be blank")
  .refine(
    (value) => !/[\u0000-\u001f\u007f]/u.test(value),
    "Deny globs cannot contain control characters",
  )
  .refine((value) => !value.startsWith("!"), "Deny globs cannot negate exclusions")
  .refine((value) => {
    const normalized = value.replaceAll("\\", "/");
    return !normalized.startsWith("/") && !/^[A-Za-z]:/u.test(normalized);
  }, "Deny globs must be relative")
  .refine((value) => {
    const segments = value.replaceAll("\\", "/").split("/");
    return segments.every((segment) => segment !== "." && segment !== "..");
  }, "Deny globs cannot traverse directories");

const DenyGlobsSchema = z
  .array(DenyGlobSchema)
  .max(MAX_DENY_GLOBS)
  .superRefine((values, context) => {
    if (new Set(values).size !== values.length) {
      context.addIssue({ code: "custom", message: "Deny globs must be unique" });
    }
    const totalBytes = values.reduce(
      (total, value) => total + Buffer.byteLength(value, "utf8"),
      0,
    );
    if (totalBytes > MAX_DENY_GLOBS_BYTES) {
      context.addIssue({
        code: "custom",
        message: "Deny globs exceed the total UTF-8 byte budget",
      });
    }
  });

export const ReaderConfigSchema = z
  .object({
    dataDir: AbsoluteDataDirectorySchema,
    rootId: z.string().regex(/^[a-f0-9]{64}$/u, "Expected a lowercase SHA-256 root id"),
    retentionDays: z.number().int().min(MIN_RETENTION_DAYS).max(MAX_RETENTION_DAYS),
    draftRetentionDays: z.number().int().min(MIN_RETENTION_DAYS).max(MAX_RETENTION_DAYS),
    denyGlobs: DenyGlobsSchema,
  })
  .strict()
  .superRefine((config, context) => {
    if (config.draftRetentionDays < config.retentionDays) {
      context.addIssue({
        code: "custom",
        path: ["draftRetentionDays"],
        message: "Draft retention must not be shorter than completed-record retention",
      });
    }
  });

export type ReaderConfig = z.infer<typeof ReaderConfigSchema>;

declare const ReaderStorageAuthorityBrand: unique symbol;
export type ReaderStorageAuthority = Readonly<{
  [ReaderStorageAuthorityBrand]: true;
}>;

export type ReaderStorageAuthorityMetadata = Readonly<{
  dataDir: string;
  projectRoot: string;
  platform: NodeJS.Platform;
}>;

const authorityByConfig = new WeakMap<object, ReaderStorageAuthority>();
const metadataByAuthority = new WeakMap<object, ReaderStorageAuthorityMetadata>();

export type ReaderConfigEnvironment = Readonly<
  Partial<Record<
    | "AIMD_DATA_DIR"
    | "AIMD_RETENTION_DAYS"
    | "AIMD_DRAFT_RETENTION_DAYS"
    | "AIMD_DENY_GLOBS"
    | "LOCALAPPDATA"
    | "XDG_STATE_HOME"
    | "XDG_DATA_HOME",
    string
  >>
>;

export interface ReaderConfigLoadOptions {
  /** Canonical project root. Production callers must pass the verified root. */
  projectRoot?: string;
  /** Test/platform adapter override for the OS user-data base directory. */
  userDataBaseDir?: string;
  platform?: NodeJS.Platform;
  homeDirectory?: string;
}

export class ReaderConfigError extends Error {
  readonly code = "INVALID_READER_CONFIG";

  constructor(
    readonly setting: string,
    detail: string,
    options?: ErrorOptions,
  ) {
    super(`Invalid ${setting}: ${detail}`, options);
    this.name = "ReaderConfigError";
  }
}

export function getReaderStorageAuthority(config: ReaderConfig): ReaderStorageAuthority {
  const authority = authorityByConfig.get(config);
  if (authority === undefined) {
    throw new ReaderConfigError(
      "ReaderConfig",
      "storage authority requires the exact issued config identity",
    );
  }
  return authority;
}

export function resolveReaderStorageAuthority(
  authority: unknown,
): ReaderStorageAuthorityMetadata {
  if ((typeof authority !== "object" && typeof authority !== "function") || authority === null) {
    throw new ReaderConfigError("storageAuthority", "unrecognized storage authority");
  }
  const metadata = metadataByAuthority.get(authority);
  if (metadata === undefined) {
    throw new ReaderConfigError("storageAuthority", "unrecognized storage authority");
  }
  return metadata;
}

function configError(setting: string, detail: string, cause?: unknown): never {
  throw new ReaderConfigError(setting, detail, cause === undefined ? undefined : { cause });
}

function canonicalizeNearestExisting(
  value: string,
  setting: string,
  platform: NodeJS.Platform,
): string {
  const path = platform === "win32" ? win32 : posix;
  const normalized = path.resolve(value);
  if (platform !== process.platform) return normalized;
  const suffix: string[] = [];
  let cursor = normalized;
  while (true) {
    try {
      const ancestor = realpathSync.native(cursor);
      return suffix.length === 0
        ? path.normalize(ancestor)
        : path.join(ancestor, ...suffix.reverse());
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") {
        return configError(setting, "path could not be canonicalized");
      }
      const parent = path.dirname(cursor);
      if (parent === cursor) {
        return configError(setting, "path has no canonical existing ancestor");
      }
      suffix.push(path.basename(cursor));
      cursor = parent;
    }
  }
}

function isProjectContained(
  projectRoot: string,
  candidate: string,
  platform: NodeJS.Platform,
): boolean {
  if (platform !== "win32") {
    return isCanonicalPathContained(projectRoot, candidate, platform);
  }
  return isCanonicalPathContained(
    projectRoot.toLocaleLowerCase("en-US"),
    candidate.toLocaleLowerCase("en-US"),
    platform,
  );
}

function parseRetention(setting: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  if (!/^[0-9]+$/u.test(raw)) {
    return configError(setting, `expected an integer from ${MIN_RETENTION_DAYS} to ${MAX_RETENTION_DAYS}`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < MIN_RETENTION_DAYS || value > MAX_RETENTION_DAYS) {
    return configError(setting, `expected an integer from ${MIN_RETENTION_DAYS} to ${MAX_RETENTION_DAYS}`);
  }
  return value;
}

function parseDenyGlobs(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  let candidate: unknown;
  try {
    candidate = JSON.parse(raw);
  } catch {
    return configError("AIMD_DENY_GLOBS", "expected a JSON string array");
  }
  const parsed = DenyGlobsSchema.safeParse(candidate);
  if (!parsed.success) {
    return configError("AIMD_DENY_GLOBS", parsed.error.issues[0]?.message ?? "expected a JSON string array");
  }
  return parsed.data;
}

function defaultUserDataBase(
  environment: ReaderConfigEnvironment,
  platform: NodeJS.Platform,
  homeDirectory: string,
): string {
  const path = platform === "win32" ? win32 : posix;
  if (platform === "win32") {
    return environment.LOCALAPPDATA ?? path.join(homeDirectory, "AppData", "Local");
  }
  if (platform === "darwin") {
    return path.join(homeDirectory, "Library", "Application Support");
  }
  return environment.XDG_STATE_HOME ??
    environment.XDG_DATA_HOME ??
    path.join(homeDirectory, ".local", "state");
}

function isAbsoluteForPlatform(value: string, platform: NodeJS.Platform): boolean {
  if (platform !== "win32") return posix.isAbsolute(value);
  if (!win32.isAbsolute(value)) return false;
  return win32.parse(value).root.replace(/[\\/]+$/u, "").length > 0;
}

function validateBaseDirectory(
  value: string,
  setting: string,
  platform: NodeJS.Platform,
): string {
  const path = platform === "win32" ? win32 : posix;
  const parsed = AbsoluteDataDirectorySchema.safeParse(value);
  if (!parsed.success) {
    return configError(setting, parsed.error.issues[0]?.message ?? "expected an absolute directory");
  }
  if (!isAbsoluteForPlatform(parsed.data, platform)) {
    return configError(setting, "expected a fully-qualified absolute directory for this platform");
  }
  return path.resolve(parsed.data);
}

/**
 * Parses the reader's local environment without weakening invalid values to
 * defaults. The resolved storage directory is always namespaced by a one-way
 * project-root digest and is rejected when it points inside the project.
 */
export function loadReaderConfig(
  environment: ReaderConfigEnvironment = process.env,
  options: ReaderConfigLoadOptions = {},
): ReaderConfig {
  const retentionDays = parseRetention(
    "AIMD_RETENTION_DAYS",
    environment.AIMD_RETENTION_DAYS,
    DEFAULT_RETENTION_DAYS,
  );
  const draftRetentionDays = parseRetention(
    "AIMD_DRAFT_RETENTION_DAYS",
    environment.AIMD_DRAFT_RETENTION_DAYS,
    DEFAULT_DRAFT_RETENTION_DAYS,
  );
  if (draftRetentionDays < retentionDays) {
    return configError(
      "AIMD_DRAFT_RETENTION_DAYS",
      "must be greater than or equal to AIMD_RETENTION_DAYS",
    );
  }
  const denyGlobs = parseDenyGlobs(environment.AIMD_DENY_GLOBS);
  if (options.projectRoot === undefined) {
    return configError("projectRoot", "an explicit verified project root is required");
  }
  const platform = options.platform ?? process.platform;
  const path = platform === "win32" ? win32 : posix;
  if (
    !isAbsoluteForPlatform(options.projectRoot, platform) ||
    options.projectRoot.includes("\0")
  ) {
    return configError("projectRoot", "expected a canonical absolute project root");
  }
  const projectRoot = canonicalizeNearestExisting(
    path.normalize(options.projectRoot),
    "projectRoot",
    platform,
  );
  const rootId = createHash("sha256").update(projectRoot).digest("hex");
  const homeDirectory = options.homeDirectory ?? homedir();
  const explicitBase = environment.AIMD_DATA_DIR;
  const rawBase = explicitBase ?? options.userDataBaseDir ??
    defaultUserDataBase(environment, platform, homeDirectory);
  const base = validateBaseDirectory(
    rawBase,
    explicitBase === undefined ? "OS_USER_DATA_DIR" : "AIMD_DATA_DIR",
    platform,
  );
  const unresolvedDataDir = explicitBase === undefined
    ? path.join(base, "aimd-reader", rootId)
    : path.join(base, rootId);
  const dataDir = canonicalizeNearestExisting(
    unresolvedDataDir,
    explicitBase === undefined ? "OS_USER_DATA_DIR" : "AIMD_DATA_DIR",
    platform,
  );

  if (isProjectContained(projectRoot, dataDir, platform)) {
    return configError("AIMD_DATA_DIR", "storage must not be located inside the project root");
  }

  const candidate = {
    dataDir,
    rootId,
    retentionDays,
    draftRetentionDays,
    denyGlobs,
  };
  const parsed = ReaderConfigSchema.safeParse(candidate);
  if (!parsed.success) {
    return configError("ReaderConfig", parsed.error.issues[0]?.message ?? "invalid resolved configuration");
  }
  Object.freeze(parsed.data.denyGlobs);
  const config = Object.freeze(parsed.data);
  const authority = Object.freeze(Object.create(null)) as ReaderStorageAuthority;
  const metadata = Object.freeze({ dataDir, projectRoot, platform });
  authorityByConfig.set(config, authority);
  metadataByAuthority.set(authority, metadata);
  return config;
}
