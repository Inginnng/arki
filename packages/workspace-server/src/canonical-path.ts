import { posix, win32 } from "node:path";

export type CanonicalPathPlatform = NodeJS.Platform;

type CanonicalParts = Readonly<{
  volume: string;
  components: readonly string[];
}>;

function stripExtendedWindowsPrefix(value: string): string | null {
  if (/^\\\\\?\\GLOBALROOT(?:\\|$)/iu.test(value)) return null;
  if (/^\\\\\?\\UNC\\/iu.test(value)) return `\\\\${value.slice(8)}`;
  if (/^\\\\\?\\[A-Za-z]:\\/u.test(value)) return value.slice(4);
  if (/^\\\\[.?]\\/u.test(value)) return null;
  return value;
}

function windowsParts(value: string): CanonicalParts | null {
  const withoutPrefix = stripExtendedWindowsPrefix(value);
  if (withoutPrefix === null || !win32.isAbsolute(withoutPrefix)) return null;
  const normalized = win32.normalize(withoutPrefix);
  const parsed = win32.parse(normalized);
  if (parsed.root.length === 0) return null;
  return {
    // Drive letters and UNC server/share roots use Windows volume semantics.
    // Directory components may be case-sensitive on modern Windows and must
    // therefore remain byte-for-byte exact after realpath canonicalization.
    volume: parsed.root.replace(/[\\/]+$/u, "").toLowerCase(),
    components: normalized
      .slice(parsed.root.length)
      .split(/[\\/]+/u)
      .filter((component) => component.length > 0),
  };
}

function posixParts(value: string): CanonicalParts | null {
  if (!posix.isAbsolute(value)) return null;
  const normalized = posix.normalize(value);
  return {
    volume: "/",
    components: normalized.split("/").filter((component) => component.length > 0),
  };
}

function parts(value: string, platform: CanonicalPathPlatform): CanonicalParts | null {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) return null;
  return platform === "win32" ? windowsParts(value) : posixParts(value);
}

export function isCanonicalPathContained(
  root: string,
  candidate: string,
  platform: CanonicalPathPlatform = process.platform,
): boolean {
  const rootParts = parts(root, platform);
  const candidateParts = parts(candidate, platform);
  if (
    rootParts === null || candidateParts === null ||
    rootParts.volume !== candidateParts.volume ||
    candidateParts.components.length < rootParts.components.length
  ) return false;
  return rootParts.components.every(
    (component, index) => candidateParts.components[index] === component,
  );
}

export function sameCanonicalPath(
  left: string,
  right: string,
  platform: CanonicalPathPlatform = process.platform,
): boolean {
  const leftParts = parts(left, platform);
  const rightParts = parts(right, platform);
  return leftParts !== null && rightParts !== null &&
    leftParts.volume === rightParts.volume &&
    leftParts.components.length === rightParts.components.length &&
    leftParts.components.every((component, index) => rightParts.components[index] === component);
}

export function canonicalPathKey(
  value: string,
  platform: CanonicalPathPlatform = process.platform,
): string | null {
  const parsed = parts(value, platform);
  return parsed === null ? null : JSON.stringify([parsed.volume, ...parsed.components]);
}
