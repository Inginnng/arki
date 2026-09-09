import { describe, expect, it } from "vitest";

import {
  enumeratePathExecutableCandidates,
  type ExecutableResolverDependencies,
  resolveCodexExecutable,
} from "./executable.js";

function windowsDependencies(input?: {
  files?: string[];
  pathResult?: string | null;
  pathResults?: string[];
  realpaths?: Record<string, string>;
  versions?: Record<string, string>;
  appServerCompatible?: Record<string, boolean>;
  onPathLookup?: () => void;
  onRun?: (executable: string, args: readonly string[]) => void;
}): ExecutableResolverDependencies {
  const files = new Set(input?.files ?? []);
  const versions = input?.versions ?? {};
  const compatible = input?.appServerCompatible ?? {};
  return {
    platform: "win32",
    isFile: async (candidate) => files.has(candidate),
    realpath: async (candidate) => input?.realpaths?.[candidate] ?? candidate,
    findOnPath: async () => {
      input?.onPathLookup?.();
      return input?.pathResult ?? null;
    },
    findAllOnPath: async () => {
      input?.onPathLookup?.();
      return input?.pathResults ?? (input?.pathResult ? [input.pathResult] : []);
    },
    run: async (executable, args) => {
      input?.onRun?.(executable, args);
      if (args[0] === "--version") {
        const version = versions[executable];
        return version
          ? { status: 0, stdout: `codex-cli ${version}\n` }
          : { status: 1, stdout: "" };
      }
      if (args[0] === "app-server" && args[1] === "--help") {
        return compatible[executable] === false
          ? { status: 0, stdout: "Usage: codex app-server" }
          : { status: 0, stdout: "Usage: codex app-server\nCommands: generate-ts" };
      }
      return { status: 1, stdout: "" };
    },
  };
}

describe("resolveCodexExecutable", () => {
  it("enumerates bounded PATH/PATHEXT candidates without a lookup executable", () => {
    const manyDirectories = Array.from(
      { length: 100 },
      (_, index) => `C:\\Bin${index}`,
    ).join(";");
    const candidates = enumeratePathExecutableCandidates("win32", "codex", {
      Path: `C:\\Bin;C:\\BIN;;relative;${manyDirectories}`,
      PATHEXT: ".CMD;.EXE;.EXE;.unsafe/path",
    });

    expect(candidates.slice(0, 2)).toEqual([
      "C:\\Bin\\codex",
      "C:\\Bin\\codex.EXE",
    ]);
    expect(candidates).toHaveLength(32);
    expect(candidates).not.toContain("C:\\Bin\\codex.CMD");
    expect(candidates.every((candidate) => !candidate.includes("relative"))).toBe(true);
  });

  it("prefers an explicit AIMD_CODEX_BIN over host and PATH candidates", async () => {
    const explicit = "C:\\Explicit\\codex.exe";
    const host = "C:\\Desktop\\codex.exe";
    const path = "C:\\Path\\codex.exe";
    const result = await resolveCodexExecutable(
      {
        env: { AIMD_CODEX_BIN: explicit },
        verifiedHostHint: { path: host, version: "0.151.0", verified: true },
        desktopVersion: "0.151.0",
      },
      windowsDependencies({
        files: [explicit, host, path],
        pathResult: path,
        versions: { [explicit]: "0.151.0", [host]: "0.151.0", [path]: "0.152.0" },
      }),
    );

    expect(result).toMatchObject({
      status: "resolved",
      source: "environment",
      executablePath: explicit,
      version: "0.151.0",
      trust: "operator_explicit",
      exactContextEligible: true,
    });
  });

  it("does not trust an inherited AIMD_CODEX_BIN as operator-explicit", async () => {
    const inherited = "C:\\Inherited\\codex.exe";
    const host = "C:\\Desktop\\codex.exe";
    const env = Object.create({ AIMD_CODEX_BIN: inherited }) as Record<string, string>;
    const result = await resolveCodexExecutable(
      {
        env,
        verifiedHostHint: { path: host, version: "0.151.0", verified: true },
        desktopVersion: "0.151.0",
      },
      windowsDependencies({
        files: [inherited, host],
        versions: { [inherited]: "0.151.0", [host]: "0.151.0" },
      }),
    );

    expect(result).toMatchObject({
      status: "resolved",
      source: "verified_host_hint",
      executablePath: host,
      trust: "verified_host",
    });
  });

  it("rejects an accessor AIMD_CODEX_BIN without invoking it", async () => {
    let getterCalls = 0;
    const env = Object.defineProperty({}, "AIMD_CODEX_BIN", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "C:\\Accessor\\codex.exe";
      },
    }) as Record<string, string>;
    const result = await resolveCodexExecutable(
      {
        env,
        verifiedHostHint: {
          path: "C:\\Desktop\\codex.exe",
          version: "0.151.0",
          verified: true,
        },
      },
      windowsDependencies({
        files: ["C:\\Accessor\\codex.exe", "C:\\Desktop\\codex.exe"],
        versions: {
          "C:\\Accessor\\codex.exe": "0.151.0",
          "C:\\Desktop\\codex.exe": "0.151.0",
        },
      }),
    );

    expect(result).toEqual({
      status: "unavailable",
      code: "CODEX_BINARY_INVALID",
      retryable: false,
    });
    expect(getterCalls).toBe(0);
  });

  it("lets a verified desktop host hint win when PATH is a newer mismatched CLI", async () => {
    const host = "C:\\Desktop\\codex.exe";
    const path = "C:\\Path\\codex.exe";
    const result = await resolveCodexExecutable(
      {
        env: {},
        verifiedHostHint: { path: host, version: "0.151.0-alpha.7.2", verified: true },
        desktopVersion: "0.151.0-alpha.7.2",
      },
      windowsDependencies({
        files: [host, path],
        pathResult: path,
        versions: { [host]: "0.151.0-alpha.7.2", [path]: "0.152.0" },
      }),
    );

    expect(result).toMatchObject({
      status: "resolved",
      source: "verified_host_hint",
      executablePath: host,
      version: "0.151.0-alpha.7.2",
      trust: "verified_host",
      exactContextEligible: true,
    });
  });

  it("ignores an unverified host path and resolves an absolute PATH executable", async () => {
    const unverified = "C:\\Unverified\\codex.exe";
    const path = "C:\\Path\\codex.exe";
    const result = await resolveCodexExecutable(
      {
        env: {},
        verifiedHostHint: { path: unverified, version: "0.151.0", verified: false },
      },
      windowsDependencies({
        files: [unverified, path],
        pathResult: path,
        versions: { [path]: "0.152.0" },
      }),
    );

    expect(result).toMatchObject({
      status: "resolved",
      source: "path",
      executablePath: path,
      trust: "development_path",
      exactContextEligible: false,
    });
  });

  it("treats an empty explicit AIMD_CODEX_BIN as authoritative failure", async () => {
    let pathLookups = 0;
    const result = await resolveCodexExecutable(
      { env: { AIMD_CODEX_BIN: "   " } },
      windowsDependencies({
        pathResult: "C:\\Path\\codex.exe",
        onPathLookup: () => {
          pathLookups += 1;
        },
      }),
    );

    expect(result).toEqual({
      status: "unavailable",
      code: "CODEX_BINARY_INVALID",
      retryable: false,
    });
    expect(pathLookups).toBe(0);
  });

  it("preserves an extensionless Windows codex basename after validation", async () => {
    const path = "C:\\Path\\codex";
    const result = await resolveCodexExecutable(
      { env: {} },
      windowsDependencies({
        files: [path],
        pathResult: path,
        versions: { [path]: "0.151.0-alpha.7.2" },
      }),
    );

    expect(result).toMatchObject({
      status: "resolved",
      executablePath: path,
      executableBasename: "codex",
    });
  });

  it("reports a missing executable without guessing installation paths", async () => {
    const result = await resolveCodexExecutable(
      { env: {} },
      windowsDependencies({ pathResult: null }),
    );
    expect(result).toEqual({
      status: "unavailable",
      code: "CODEX_BINARY_MISSING",
      retryable: false,
    });
  });

  it("never probes a PATH executable for exact desktop context", async () => {
    const path = "C:\\Path\\codex.exe";
    let runs = 0;
    const result = await resolveCodexExecutable(
      { env: {}, desktopVersion: "0.151.0-alpha.7.2" },
      windowsDependencies({
        files: [path],
        pathResult: path,
        versions: { [path]: "0.151.0-alpha.7.2" },
        onRun: () => {
          runs += 1;
        },
      }),
    );
    expect(result).toEqual({
      status: "unavailable",
      code: "CODEX_PATH_UNTRUSTED_FOR_EXACT_CONTEXT",
      retryable: false,
    });
    expect(runs).toBe(0);
  });

  it("skips lexical and canonical PATH candidates under untrusted roots", async () => {
    const lexical = "C:\\Project\\tools\\codex.exe";
    const alias = "C:\\TrustedAlias\\codex.exe";
    const external = "C:\\Trusted\\codex.exe";
    const probed: string[] = [];
    const result = await resolveCodexExecutable(
      { env: {}, untrustedRoots: ["C:\\Project"] },
      windowsDependencies({
        files: [lexical, alias, external],
        pathResults: [lexical, alias, external],
        realpaths: { [alias]: "C:\\PROJECT\\aliased\\codex.exe" },
        versions: { [external]: "0.152.0" },
        onRun: (executable) => {
          probed.push(executable);
        },
      }),
    );

    expect(result).toMatchObject({
      status: "resolved",
      source: "path",
      executablePath: external,
      trust: "development_path",
      exactContextEligible: false,
    });
    expect(probed.every((candidate) => candidate === external)).toBe(true);
  });

  it("deduplicates Windows PATH candidates case-insensitively before probing", async () => {
    const first = "C:\\Path\\codex.exe";
    const duplicate = "c:\\path\\CODEX.EXE";
    let versionRuns = 0;
    const result = await resolveCodexExecutable(
      { env: {} },
      windowsDependencies({
        files: [first, duplicate],
        pathResults: [first, duplicate],
        versions: { [first]: "0.152.0", [duplicate]: "0.152.0" },
        appServerCompatible: { [first]: false, [duplicate]: false },
        onRun: (_executable, args) => {
          if (args[0] === "--version") versionRuns += 1;
        },
      }),
    );

    expect(result).toMatchObject({
      status: "unavailable",
      code: "CODEX_APP_SERVER_INCOMPATIBLE",
    });
    expect(versionRuns).toBe(1);
  });

  it("does not fall back to PATH when an explicit executable is incompatible", async () => {
    const explicit = "C:\\Explicit\\codex.exe";
    const desktop = "C:\\Desktop\\bin\\codex.exe";
    const base = windowsDependencies({
      files: [explicit, desktop],
      pathResult: desktop,
      versions: {
        [explicit]: "0.152.0",
        [desktop]: "0.151.0-alpha.7.2",
      },
    });
    const result = await resolveCodexExecutable(
      {
        env: { AIMD_CODEX_BIN: explicit },
        desktopVersion: "0.151.0-alpha.7.2",
      },
      {
        ...base,
        findAllOnPath: async () => [desktop],
      } as ExecutableResolverDependencies,
    );

    expect(result).toEqual({
      status: "unavailable",
      code: "CODEX_DESKTOP_VERSION_MISMATCH",
      retryable: false,
      resolvedVersion: "0.152.0",
      expectedVersion: "0.151.0-alpha.7.2",
    });
  });

  it("rejects relative explicit paths instead of resolving them from cwd", async () => {
    const result = await resolveCodexExecutable(
      { env: { AIMD_CODEX_BIN: ".\\codex.exe" } },
      windowsDependencies({ files: [".\\codex.exe"] }),
    );
    expect(result).toEqual({
      status: "unavailable",
      code: "CODEX_BINARY_NOT_ABSOLUTE",
      retryable: false,
    });
  });

  it("rejects binaries that lack the generated App Server contract", async () => {
    const path = "C:\\Path\\codex.exe";
    const result = await resolveCodexExecutable(
      { env: {} },
      windowsDependencies({
        files: [path],
        pathResult: path,
        versions: { [path]: "0.152.0" },
        appServerCompatible: { [path]: false },
      }),
    );
    expect(result).toEqual({
      status: "unavailable",
      code: "CODEX_APP_SERVER_INCOMPATIBLE",
      retryable: false,
      resolvedVersion: "0.152.0",
    });
  });
});
