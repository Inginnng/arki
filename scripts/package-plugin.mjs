import { builtinModules } from "node:module";
import { createHash } from "node:crypto";
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  open,
  opendir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, posix, resolve, win32 } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const scriptRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MAX_SERVER_BYTES = 10 * 1024 * 1024;
const MAX_PROBE_BYTES = 4 * 1024 * 1024;
const MAX_READER_BYTES = 4 * 1024 * 1024;
const MAX_SAFE_WRITE_HELPER_BYTES = 256 * 1024;

function assertInside(parent, candidate, label) {
  if (isCanonicalPathContained(resolve(parent), resolve(candidate))) return;
  throw new Error(`${label} is outside the expected plugin root`);
}

function parseArguments(argv) {
  const options = { workspaceRoot: scriptRoot, pluginDir: undefined, marketplacePath: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    const value = argv[index + 1];
    if ((name === "--workspace-root" || name === "--plugin-dir" || name === "--marketplace-path") && value) {
      if (name === "--workspace-root") options.workspaceRoot = resolve(value);
      else if (name === "--plugin-dir") options.pluginDir = resolve(value);
      else options.marketplacePath = resolve(value);
      index += 1;
      continue;
    }
    throw new Error("Unknown or incomplete package-plugin argument");
  }
  options.pluginDir ??= join(options.workspaceRoot, "plugins", "aimd-reader");
  return options;
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return false;
    throw error;
  }
}

function fullyPercentEncode(value) {
  return Array.from(Buffer.from(value, "utf8"), (byte) => `%${byte.toString(16).padStart(2, "0")}`).join("");
}

function normalizedVariants(path) {
  const raw = resolve(path);
  const slash = raw.replaceAll("\\", "/");
  const fileUrl = pathToFileURL(raw).href;
  const bases = new Set([raw, slash, fileUrl]);
  const variants = new Set();
  for (const base of bases) {
    variants.add(base);
    variants.add(base.replaceAll("\\", "\\\\"));
    variants.add(base.replaceAll("/", "\\/"));
    variants.add(JSON.stringify(base).slice(1, -1));
    variants.add(encodeURI(base));
    variants.add(encodeURIComponent(base));
    variants.add(fullyPercentEncode(base));
  }
  return new Set(Array.from(variants, (variant) => variant.toLowerCase()));
}

function decodePercentByteRuns(value) {
  return value.replace(/(?:%[0-9a-f]{2})+/giu, (encoded) => {
    const bytes = encoded.match(/[0-9a-f]{2}/giu);
    return bytes ? Buffer.from(bytes.map((byte) => Number.parseInt(byte, 16))).toString("utf8") : encoded;
  });
}

function decodeJavaScriptPathEscapes(value) {
  return value
    .replace(/\\u\{([0-9a-f]{1,6})\}/giu, (encoded, codePoint) => {
      const value = Number.parseInt(codePoint, 16);
      return value <= 0x10ffff ? String.fromCodePoint(value) : encoded;
    })
    .replace(/\\u([0-9a-f]{4})/giu, (_encoded, codePoint) =>
      String.fromCodePoint(Number.parseInt(codePoint, 16)))
    .replace(/\\x([0-9a-f]{2})/giu, (_encoded, codePoint) =>
      String.fromCodePoint(Number.parseInt(codePoint, 16)));
}

function artifactPathInspectionViews(text) {
  const views = new Set([text]);
  let decoded = text;
  for (let pass = 0; pass < 3; pass += 1) {
    decoded = decodeJavaScriptPathEscapes(decodePercentByteRuns(decoded));
    views.add(decoded);
  }
  views.add(decodePercentByteRuns(decodeJavaScriptPathEscapes(text)));
  return views;
}

function normalizeGeneratedHtml(bytes) {
  return Buffer.from(bytes.toString("utf8").replace(/^[\t ]+$/gmu, ""), "utf8");
}

function containsWindowsDevicePath(text) {
  const prefixPattern = /(?:^|[\s"'\x60(=:,{\[])(?:\\{2,}[?.]\\+|\\+\?\?\\+)/gu;
  for (const match of text.matchAll(prefixPattern)) {
    const suffix = text.slice((match.index ?? 0) + match[0].length);
    if (
      /^(?:[A-Za-z]:\\+|UNC\\+[A-Za-z0-9._$-]+\\+[A-Za-z0-9._$-]+|[A-Za-z0-9._$-]+(?=\\+|[\s"'<>)]|$))/iu
        .test(suffix)
    ) return true;
  }
  return false;
}

function portableWindowsPathLeakKind(text) {
  if (/(?:^|[^A-Za-z0-9_])[A-Za-z]:[\\/]/u.test(text)) return "drive";
  if (
    /(?:^|[^A-Za-z0-9+.-])file:[\\/]{2,}(?:[A-Za-z]:[\\/]|[A-Za-z0-9._$~-]+[\\/][^\s"'<>)]*|[A-Za-z0-9._$~-]+(?=[\s"'<>)]|$))/iu
      .test(text)
  ) return "file-url";
  if (containsWindowsDevicePath(text)) return "device";
  if (/(?:^|[\s"'\x60(=:,{\[])\\{2,}[A-Za-z0-9._$-]+\\+[A-Za-z0-9._$ -]+(?=\\+|[\s"'<>)]|$)/u.test(text)) return "unc-backslash";
  if (/(?:^|[\s"'\x60(=,{\[])\/\/[A-Za-z0-9._$-]+\/[A-Za-z0-9._$-]+(?=\/|[\s"'<>)]|$)/u.test(text)) return "unc-slash";
  return undefined;
}

export function assertArtifactHasNoKnownLocalPath(text, paths) {
  const lower = text.toLowerCase();
  for (const path of paths) {
    for (const variant of normalizedVariants(path)) {
      if (variant.length > 3 && lower.includes(variant)) {
        throw new Error("Packaged artifact contains a local absolute path");
      }
    }
  }
  if (/sourceMappingURL/i.test(text)) {
    throw new Error("Packaged artifact contains a source map reference");
  }
}

export function assertArtifactIsPathClean(text, paths) {
  assertArtifactHasNoKnownLocalPath(text, paths);
  const portableLeakKind = Array.from(artifactPathInspectionViews(text))
    .map(portableWindowsPathLeakKind)
    .find(Boolean);
  if (portableLeakKind || /\/(?:users|home)\/[^/\s"']+/i.test(text)) {
    throw new Error(`Packaged artifact contains a local absolute path (${portableLeakKind ?? "posix"})`);
  }
}

const BROWSER_ONLY_MARKERS = [
  "data-aimd-probe-auto-start",
  "AIMD probe host did not grant fullscreen",
  "globalThis.crypto.subtle",
];
const SERVER_ONLY_MARKERS = ["STARTUP_FAILED", "node:fs/promises", ".stdin", ".stdout", "process.stderr"];

export function assertArtifactBoundaries(serverText, probeText) {
  for (const marker of BROWSER_ONLY_MARKERS) {
    if (serverText.includes(marker)) throw new Error("Server artifact contains browser-only bootstrap code");
  }
  for (const marker of SERVER_ONLY_MARKERS) {
    if (probeText.includes(marker)) throw new Error("Probe artifact contains server process code");
  }
}

function stripExtendedWindowsPrefix(value) {
  if (/^\\\\\?\\GLOBALROOT(?:\\|$)/iu.test(value)) return null;
  if (/^\\\\\?\\UNC\\/iu.test(value)) return `\\\\${value.slice(8)}`;
  if (/^\\\\\?\\[A-Za-z]:\\/u.test(value)) return value.slice(4);
  if (/^\\\\[.?]\\/u.test(value)) return null;
  return value;
}

function canonicalParts(value, platform) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) return null;
  if (platform === "win32") {
    const withoutPrefix = stripExtendedWindowsPrefix(value);
    if (withoutPrefix === null || !win32.isAbsolute(withoutPrefix)) return null;
    const normalized = win32.normalize(withoutPrefix);
    const root = win32.parse(normalized).root;
    if (!root) return null;
    return {
      volume: root.replace(/[\\/]+$/u, "").toLowerCase(),
      components: normalized.slice(root.length).split(/[\\/]+/u).filter(Boolean),
    };
  }
  if (!posix.isAbsolute(value)) return null;
  const normalized = posix.normalize(value);
  return { volume: "/", components: normalized.split("/").filter(Boolean) };
}

export function sameCanonicalPath(left, right, platform = process.platform) {
  const leftParts = canonicalParts(left, platform);
  const rightParts = canonicalParts(right, platform);
  return leftParts !== null && rightParts !== null &&
    leftParts.volume === rightParts.volume &&
    leftParts.components.length === rightParts.components.length &&
    leftParts.components.every((component, index) => rightParts.components[index] === component);
}

export function isCanonicalPathContained(parent, candidate, platform = process.platform) {
  const parentParts = canonicalParts(parent, platform);
  const candidateParts = canonicalParts(candidate, platform);
  return parentParts !== null && candidateParts !== null &&
    parentParts.volume === candidateParts.volume &&
    candidateParts.components.length >= parentParts.components.length &&
    parentParts.components.every((component, index) => candidateParts.components[index] === component);
}

function identityOf(info) {
  return { device: String(info.dev), inode: String(info.ino) };
}

async function readAuditedOrdinaryFile(path, maximumBytes) {
  const requestedPath = resolve(path);
  let handle;
  try {
    handle = await open(requestedPath, "r");
    const opened = await handle.stat({ bigint: true });
    const canonicalPath = await realpath(requestedPath);
    const pathState = await lstat(requestedPath, { bigint: true });
    if (
      !opened.isFile() || pathState.isSymbolicLink() ||
      !sameCanonicalPath(requestedPath, canonicalPath) ||
      opened.dev !== pathState.dev || opened.ino !== pathState.ino ||
      opened.size !== pathState.size || opened.mtimeNs !== pathState.mtimeNs ||
      opened.ctimeNs !== pathState.ctimeNs || opened.size > BigInt(maximumBytes)
    ) throw new Error("Packaged helper source is not a stable ordinary file");
    const bytes = await handle.readFile();
    const finalHandle = await handle.stat({ bigint: true });
    const finalPath = await lstat(requestedPath, { bigint: true });
    if (
      bytes.byteLength !== Number(finalHandle.size) ||
      finalHandle.dev !== opened.dev || finalHandle.ino !== opened.ino ||
      finalHandle.size !== opened.size || finalHandle.mtimeNs !== opened.mtimeNs ||
      finalHandle.ctimeNs !== opened.ctimeNs ||
      finalPath.dev !== finalHandle.dev || finalPath.ino !== finalHandle.ino ||
      finalPath.size !== finalHandle.size || finalPath.mtimeNs !== finalHandle.mtimeNs ||
      finalPath.ctimeNs !== finalHandle.ctimeNs
    ) throw new Error("Packaged helper source changed while it was read");
    return bytes;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function assertOrdinaryDirectory(path, expectedParentCanonicalPath) {
  const [info, canonicalPath] = await Promise.all([
    lstat(path, { bigint: true }),
    realpath(path),
  ]);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error("Private package directory is a symbolic link or reparse point");
  }
  if (!sameCanonicalPath(dirname(canonicalPath), expectedParentCanonicalPath)) {
    throw new Error("Private package directory escaped its canonical parent");
  }
  return { canonicalPath, ...identityOf(info) };
}

const MAX_PRIVATE_PACKAGE_TREE_DEPTH = 64;
const MAX_PRIVATE_PACKAGE_TREE_ENTRIES = 10_000;

async function assertTreeHasNoReparsePoints(
  path,
  rootCanonicalPath,
  state = { entries: 0, maxEntries: MAX_PRIVATE_PACKAGE_TREE_ENTRIES },
  depth = 0,
  countCurrent = true,
) {
  if (depth > MAX_PRIVATE_PACKAGE_TREE_DEPTH) {
    throw new Error("Private package tree exceeds the audit depth budget");
  }
  if (countCurrent) {
    state.entries += 1;
    if (state.entries > state.maxEntries) {
      throw new Error("Private package tree exceeds the audit entry budget");
    }
  }
  const [info, canonicalPath] = await Promise.all([
    lstat(path, { bigint: true }),
    realpath(path),
  ]);
  if (info.isSymbolicLink()) {
    throw new Error("Private package tree contains a symbolic link or reparse point");
  }
  assertInside(rootCanonicalPath, canonicalPath, "Private package tree entry");
  if (!info.isDirectory()) return;
  const directory = await opendir(path);
  try {
    for await (const entry of directory) {
      state.entries += 1;
      if (state.entries > state.maxEntries) {
        throw new Error("Private package tree exceeds the audit entry budget");
      }
      if (entry.isSymbolicLink()) {
        throw new Error("Private package tree contains a symbolic link or reparse point");
      }
      await assertTreeHasNoReparsePoints(
        join(path, entry.name),
        rootCanonicalPath,
        state,
        depth + 1,
        false,
      );
    }
  } finally {
    await directory.close().catch(() => undefined);
  }
}

function privatePackageTreeEntryLimit(value) {
  if (value === undefined) return MAX_PRIVATE_PACKAGE_TREE_ENTRIES;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("Private package tree entry budget is invalid");
  }
  return Math.min(value, MAX_PRIVATE_PACKAGE_TREE_ENTRIES);
}

export async function createPrivatePackageDirectory(pluginRoot) {
  const requestedRoot = resolve(pluginRoot);
  const [pluginInfo, canonicalPluginRoot] = await Promise.all([
    lstat(requestedRoot, { bigint: true }),
    realpath(requestedRoot),
  ]);
  if (!pluginInfo.isDirectory() || pluginInfo.isSymbolicLink() || !sameCanonicalPath(requestedRoot, canonicalPluginRoot)) {
    throw new Error("Plugin root must be an ordinary canonical directory");
  }
  const path = await mkdtemp(join(requestedRoot, ".aimd-package-"));
  const captured = await assertOrdinaryDirectory(path, canonicalPluginRoot);
  return {
    path,
    canonicalPath: captured.canonicalPath,
    parentCanonicalPath: canonicalPluginRoot,
    device: captured.device,
    inode: captured.inode,
  };
}

async function assertPrivatePackageDirectoryIdentity(directory) {
  const current = await assertOrdinaryDirectory(directory.path, directory.parentCanonicalPath);
  if (
    !sameCanonicalPath(current.canonicalPath, directory.canonicalPath) ||
    current.device !== directory.device ||
    current.inode !== directory.inode
  ) {
    throw new Error("Private package directory identity changed before cleanup");
  }
  return current;
}

export async function removePrivatePackageDirectory(directory, options = {}) {
  await assertPrivatePackageDirectoryIdentity(directory);
  await assertTreeHasNoReparsePoints(
    directory.path,
    directory.canonicalPath,
    {
      entries: 0,
      maxEntries: privatePackageTreeEntryLimit(options.maxTreeEntriesForTesting),
    },
  );
  await options.afterTreeScan?.();
  await assertPrivatePackageDirectoryIdentity(directory);
  await rm(directory.path, { recursive: true, force: false, maxRetries: 2 });
}

function packageDistConflict(cause) {
  const error = new Error("Package dist changed during guarded replacement", { cause });
  error.name = "PackageDistConflictError";
  error.code = "PACKAGE_DIST_CONFLICT";
  error.preservePrivatePackageDirectory = true;
  return error;
}

async function assertDirectoryIdentityAt(path, parentCanonicalPath, expected, label) {
  const current = await assertOrdinaryDirectory(path, parentCanonicalPath);
  if (
    current.device !== expected.device ||
    current.inode !== expected.inode
  ) {
    throw new Error(`${label} identity changed during package replacement`);
  }
  return current;
}

export async function replacePackageDist({
  privateDirectory,
  stagingDist,
  targetDist,
  afterPreviousRename,
  afterPreviousMoved,
}) {
  const resolvedStagingDist = resolve(stagingDist);
  const resolvedTargetDist = resolve(targetDist);
  const backupDist = join(privateDirectory.path, "previous-dist");
  if (!sameCanonicalPath(dirname(resolvedStagingDist), privateDirectory.canonicalPath)) {
    throw new Error("Staged dist must be an immediate child of the private package directory");
  }
  if (!sameCanonicalPath(dirname(resolvedTargetDist), privateDirectory.parentCanonicalPath)) {
    throw new Error("Target dist must be an immediate child of the canonical plugin root");
  }
  await assertPrivatePackageDirectoryIdentity(privateDirectory);
  if (await pathExists(backupDist)) {
    throw new Error("Private package backup path must not already exist");
  }
  const stagedIdentity = await assertOrdinaryDirectory(
    resolvedStagingDist,
    privateDirectory.canonicalPath,
  );
  await assertTreeHasNoReparsePoints(resolvedStagingDist, stagedIdentity.canonicalPath);

  let previousIdentity;
  let previousMoved = false;
  if (await pathExists(resolvedTargetDist)) {
    previousIdentity = await assertOrdinaryDirectory(
      resolvedTargetDist,
      privateDirectory.parentCanonicalPath,
    );
    await assertTreeHasNoReparsePoints(resolvedTargetDist, previousIdentity.canonicalPath);
  }

  try {
    if (previousIdentity) {
      await assertPrivatePackageDirectoryIdentity(privateDirectory);
      await assertDirectoryIdentityAt(
        resolvedTargetDist,
        privateDirectory.parentCanonicalPath,
        previousIdentity,
        "Previous dist",
      );
      await rename(resolvedTargetDist, backupDist);
      previousMoved = true;
      await afterPreviousRename?.();
      const movedPrevious = await assertDirectoryIdentityAt(
        backupDist,
        privateDirectory.canonicalPath,
        previousIdentity,
        "Previous dist",
      );
      await assertTreeHasNoReparsePoints(backupDist, movedPrevious.canonicalPath);
      await afterPreviousMoved?.();
    }
    if (await pathExists(resolvedTargetDist)) {
      throw packageDistConflict(new Error("Target dist was recreated before install"));
    }
    await assertPrivatePackageDirectoryIdentity(privateDirectory);
    await assertDirectoryIdentityAt(
      resolvedStagingDist,
      privateDirectory.canonicalPath,
      stagedIdentity,
      "Staged dist",
    );
    await rename(resolvedStagingDist, resolvedTargetDist);
    const installed = await assertDirectoryIdentityAt(
      resolvedTargetDist,
      privateDirectory.parentCanonicalPath,
      stagedIdentity,
      "Installed dist",
    );
    await assertTreeHasNoReparsePoints(resolvedTargetDist, installed.canonicalPath);
  } catch (error) {
    if (!previousIdentity || !previousMoved) throw error;
    try {
      const preserved = await assertDirectoryIdentityAt(
        backupDist,
        privateDirectory.canonicalPath,
        previousIdentity,
        "Previous dist backup",
      );
      await assertTreeHasNoReparsePoints(backupDist, preserved.canonicalPath);
      if (await pathExists(resolvedTargetDist)) {
        throw packageDistConflict(error);
      }
      await assertPrivatePackageDirectoryIdentity(privateDirectory);
      await rename(backupDist, resolvedTargetDist);
      const restored = await assertDirectoryIdentityAt(
        resolvedTargetDist,
        privateDirectory.parentCanonicalPath,
        previousIdentity,
        "Restored dist",
      );
      await assertTreeHasNoReparsePoints(resolvedTargetDist, restored.canonicalPath);
    } catch (rollbackError) {
      if (rollbackError?.preservePrivatePackageDirectory === true) throw rollbackError;
      throw packageDistConflict(rollbackError);
    }
    throw error;
  }
}

function assertOnlyNodeBuiltinExternals(result) {
  const allowed = new Set([
    ...builtinModules,
    ...builtinModules.map((name) => `node:${name}`),
  ]);
  for (const output of Object.values(result.metafile?.outputs ?? {})) {
    for (const imported of output.imports ?? []) {
      if (imported.external && !allowed.has(imported.path)) {
        throw new Error("Server bundle retains a non-builtin runtime dependency");
      }
    }
  }
}

function isExactJsonObject(value, expectedKeys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actualKeys = Object.keys(value).sort();
  const sortedExpectedKeys = [...expectedKeys].sort();
  return (
    actualKeys.length === sortedExpectedKeys.length &&
    actualKeys.every((key, index) => key === sortedExpectedKeys[index])
  );
}

export async function validatePluginLaunchConfig(pluginDir) {
  pluginDir = resolve(pluginDir);
  const configPath = join(pluginDir, ".mcp.json");
  const manifestPath = join(pluginDir, ".codex-plugin", "plugin.json");
  const [parsed, manifest] = await Promise.all([
    readFile(configPath, "utf8").then(JSON.parse),
    readFile(manifestPath, "utf8").then(JSON.parse),
  ]);
  if (manifest?.mcpServers !== "./.mcp.json") {
    throw new Error("Plugin manifest mcpServers must point exactly to ./.mcp.json");
  }
  if (resolve(pluginDir, manifest.mcpServers) !== configPath) {
    throw new Error("Plugin manifest mcpServers resolves outside the exact launch config");
  }
  if (
    !isExactJsonObject(parsed, ["mcpServers"]) ||
    !isExactJsonObject(parsed.mcpServers, ["aimd-reader"])
  ) {
    throw new Error(".mcp.json must contain exactly the AIMD Reader MCP server");
  }
  const entry = parsed.mcpServers["aimd-reader"];
  if (
    !isExactJsonObject(entry, ["command", "cwd", "args"]) ||
    entry.command !== "node" ||
    entry.cwd !== "." ||
    !Array.isArray(entry.args) ||
    entry.args.length !== 1 ||
    entry.args[0] !== "dist/server.mjs"
  ) {
    throw new Error(".mcp.json must launch exactly dist/server.mjs from the plugin root");
  }
  const resolvedEntry = resolve(pluginDir, entry.cwd, entry.args[0]);
  const expectedEntry = resolve(pluginDir, "dist", "server.mjs");
  if (resolvedEntry !== expectedEntry) {
    throw new Error(".mcp.json resolves outside the packaged server entry");
  }
  return resolvedEntry;
}

export async function validateMarketplaceConfig(
  workspaceRoot,
  marketplacePath = join(workspaceRoot, ".agents", "plugins", "marketplace.json"),
) {
  marketplacePath = resolve(marketplacePath);
  const marketplace = JSON.parse(await readFile(marketplacePath, "utf8"));
  const expectedPluginRoot = resolve(workspaceRoot, "plugins", "aimd-reader");
  const manifest = JSON.parse(
    await readFile(join(expectedPluginRoot, ".codex-plugin", "plugin.json"), "utf8"),
  );
  const entries = marketplace?.plugins;
  const entry = Array.isArray(entries) && entries.length === 1 ? entries[0] : undefined;
  if (
    marketplace?.name !== "aimd-local" ||
    marketplace?.interface?.displayName !== "AIMD Local" ||
    !entry ||
    entry.name !== manifest?.name ||
    entry.name !== "aimd-reader" ||
    entry.source?.source !== "local" ||
    entry.source?.path !== "./plugins/aimd-reader" ||
    resolve(workspaceRoot, entry.source.path) !== expectedPluginRoot ||
    entry.policy?.installation !== "AVAILABLE" ||
    entry.policy?.authentication !== "ON_INSTALL" ||
    !Array.isArray(entry.policy?.products) ||
    entry.policy.products.length !== 1 ||
    entry.policy.products[0] !== "CODEX" ||
    entry.category !== "Developer Tools"
  ) {
    throw new Error("Repository marketplace does not match the AIMD Reader plugin manifest");
  }
  return { marketplacePath, pluginRoot: expectedPluginRoot };
}

function createProbeHtml(browserJavaScript) {
  const safeJavaScript = browserJavaScript.replace(/<\/script/giu, "<\\/script");
  return `<!doctype html>
<html lang="en" data-aimd-probe-auto-start="true">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; font-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'">
  <title>AIMD Reader capability probe</title>
  <style>
    :root { color-scheme: light dark; font-family: ui-monospace, "Cascadia Mono", monospace; }
    body { margin: 0; min-height: 100vh; background: #f4efe5; color: #1e1d1a; }
    main { box-sizing: border-box; max-width: 58rem; margin: 0 auto; padding: 3rem 2rem; }
    h1 { font: 600 1.65rem/1.25 ui-serif, Georgia, serif; margin: 0 0 1.5rem; }
    ol { padding: 0; list-style: none; border-top: 1px solid #afa79a; }
    li { padding: .8rem 0; border-bottom: 1px solid #d0c7b9; line-height: 1.45; }
    li[data-status="failed"] { color: #8e341d; }
    li[data-status="passed"] { color: #275b42; }
    @media (prefers-color-scheme: dark) {
      body { background: #1b1a18; color: #eee8dc; }
      ol { border-color: #625d55; }
      li { border-color: #49453f; }
      li[data-status="failed"] { color: #f0a086; }
      li[data-status="passed"] { color: #8ed0a9; }
    }
  </style>
</head>
<body>
  <main data-aimd-probe-status role="status" aria-live="polite">Preparing capability probe…</main>
  <script>${safeJavaScript}</script>
</body>
</html>
`;
}

export async function packagePlugin(options = {}) {
  const workspaceRoot = resolve(options.workspaceRoot ?? scriptRoot);
  const pluginDir = resolve(options.pluginDir ?? join(workspaceRoot, "plugins", "aimd-reader"));
  const marketplacePath = resolve(
    options.marketplacePath ?? join(workspaceRoot, ".agents", "plugins", "marketplace.json"),
  );
  const serverEntry = join(workspaceRoot, "packages", "workspace-server", "src", "index.ts");
  const probeEntry = join(workspaceRoot, "packages", "workspace-server", "src", "probe-ui.ts");
  const readerRoot = join(workspaceRoot, "apps", "reader-ui");
  const safeWriteHelperSource = join(workspaceRoot, "scripts", "safe-write-windows.ps1");
  const targetDist = join(pluginDir, "dist");
  assertInside(pluginDir, targetDist, "Plugin dist");
  await validateMarketplaceConfig(workspaceRoot, marketplacePath);
  await validatePluginLaunchConfig(pluginDir);

  const privateDirectory = await createPrivatePackageDirectory(pluginDir);
  const stagingRoot = privateDirectory.path;
  const stagingDist = join(stagingRoot, "dist");
  const stagedServer = join(stagingDist, "server.mjs");
  const stagedProbe = join(stagingDist, "probe.html");
  const stagedReader = join(stagingDist, "reader.html");
  const readerBuildRoot = join(stagingRoot, "reader-build");
  const stagedSafeWriteHelper = join(stagingDist, "safe-write-windows.ps1");
  let preservePrivateDirectory = false;
  try {
    assertInside(pluginDir, stagingRoot, "Package staging directory");
    await mkdir(stagingDist, { recursive: true });
    const safeWriteHelperBytes = await readAuditedOrdinaryFile(
      safeWriteHelperSource,
      MAX_SAFE_WRITE_HELPER_BYTES,
    );
    const safeWriteHelperSha256 = createHash("sha256")
      .update(safeWriteHelperBytes)
      .digest("hex");
    await writeFile(stagedSafeWriteHelper, safeWriteHelperBytes, { flag: "wx", mode: 0o600 });
    const aliases = {
      "@aimd/contracts": join(workspaceRoot, "packages", "contracts", "src", "index.ts"),
      "@aimd/reader-core": join(workspaceRoot, "packages", "reader-core", "src", "index.ts"),
      "@aimd/app-server-bridge": join(workspaceRoot, "packages", "app-server-bridge", "src", "index.ts"),
    };
    const serverBuild = await build({
      absWorkingDir: workspaceRoot,
      entryPoints: [serverEntry],
      outfile: stagedServer,
      alias: aliases,
      bundle: true,
      platform: "node",
      target: "node20",
      format: "esm",
      treeShaking: true,
      minify: true,
      legalComments: "none",
      sourcemap: false,
      define: {
        __AIMD_SAFE_WRITE_HELPER_SHA256__: JSON.stringify(safeWriteHelperSha256),
      },
      metafile: true,
      logLevel: "silent",
    });
    assertOnlyNodeBuiltinExternals(serverBuild);

    const browserBuild = await build({
      absWorkingDir: workspaceRoot,
      entryPoints: [probeEntry],
      alias: aliases,
      bundle: true,
      platform: "browser",
      target: "chrome120",
      format: "iife",
      treeShaking: true,
      minify: true,
      legalComments: "none",
      sourcemap: false,
      write: false,
      logLevel: "silent",
    });
    const browserJavaScript = browserBuild.outputFiles?.[0]?.text;
    if (!browserJavaScript) throw new Error("Probe UI bundle was not generated");
    await writeFile(stagedProbe, createProbeHtml(browserJavaScript), "utf8");

    const previousNodeEnvironment = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = "production";
      const { build: viteBuild } = await import("vite");
      await viteBuild({
        root: readerRoot,
        configFile: join(readerRoot, "vite.config.ts"),
        mode: "production",
        logLevel: "silent",
        build: { outDir: readerBuildRoot, emptyOutDir: true },
      });
    } finally {
      if (previousNodeEnvironment === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnvironment;
    }
    const readerBytes = normalizeGeneratedHtml(await readAuditedOrdinaryFile(
      join(readerBuildRoot, "index.html"),
      MAX_READER_BYTES,
    ));
    await writeFile(stagedReader, readerBytes, { flag: "wx", mode: 0o600 });

    const [serverText, probeText, readerText, serverInfo, probeInfo, readerInfo, helperInfo, packagedHelperBytes] = await Promise.all([
      readFile(stagedServer, "utf8"),
      readFile(stagedProbe, "utf8"),
      readFile(stagedReader, "utf8"),
      stat(stagedServer),
      stat(stagedProbe),
      stat(stagedReader),
      stat(stagedSafeWriteHelper),
      readFile(stagedSafeWriteHelper),
    ]);
    if (serverInfo.size <= 1_000 || serverInfo.size > MAX_SERVER_BYTES) {
      throw new Error("Packaged server size is outside the audited bounds");
    }
    if (probeInfo.size <= 1_000 || probeInfo.size > MAX_PROBE_BYTES) {
      throw new Error("Packaged probe size is outside the audited bounds");
    }
    if (readerInfo.size <= 1_000 || readerInfo.size > MAX_READER_BYTES) {
      throw new Error("Packaged reader size is outside the audited bounds");
    }
    if (
      helperInfo.size === 0 || helperInfo.size > MAX_SAFE_WRITE_HELPER_BYTES ||
      !packagedHelperBytes.equals(safeWriteHelperBytes)
    ) throw new Error("Packaged safe-write helper is outside the audited bounds");
    assertArtifactBoundaries(serverText, `${probeText}\n${readerText}`);
    assertArtifactIsPathClean(`${serverText}\n${probeText}\n${readerText}`, [workspaceRoot, pluginDir, homedir()]);
    // The audited helper necessarily contains Win32 device-path literals used
    // to reject/reopen reparse points. Check it against actual local paths,
    // without misclassifying those defensive literals as a leak.
    assertArtifactHasNoKnownLocalPath(
      packagedHelperBytes.toString("utf8"),
      [workspaceRoot, pluginDir, homedir()],
    );

    await replacePackageDist({
      privateDirectory,
      stagingDist,
      targetDist,
      afterPreviousRename: options.afterPreviousRename,
      afterPreviousMoved: options.afterPreviousMoved,
    });
    return {
      serverPath: join(targetDist, "server.mjs"),
      probePath: join(targetDist, "probe.html"),
      readerPath: join(targetDist, "reader.html"),
      safeWriteHelperPath: join(targetDist, "safe-write-windows.ps1"),
    };
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      error.preservePrivatePackageDirectory === true
    ) {
      preservePrivateDirectory = true;
    }
    throw error;
  } finally {
    if (!preservePrivateDirectory) {
      await removePrivatePackageDirectory(privateDirectory);
    }
  }
}

function isMainModule() {
  const argument = process.argv[1];
  if (!argument) return false;
  const modulePath = resolve(fileURLToPath(import.meta.url));
  const argumentPath = resolve(argument);
  return sameCanonicalPath(modulePath, argumentPath);
}

if (isMainModule()) {
  void Promise.resolve()
    .then(() => packagePlugin(parseArguments(process.argv.slice(2))))
    .catch(() => {
      process.stderr.write("AIMD plugin packaging failed safely.\n");
      process.exitCode = 1;
    });
}
