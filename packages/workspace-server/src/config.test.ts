import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import * as configModule from "./config.js";

import {
  MAX_DENY_GLOBS,
  MAX_DENY_GLOBS_BYTES,
  MAX_DENY_GLOB_LENGTH,
  ReaderConfigError,
  ReaderConfigSchema,
  loadReaderConfig,
} from "./config.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(name: string): Promise<string> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), `aimd-config-${name}-`)));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("loadReaderConfig", () => {
  it("requires an explicit verified project root and never falls back to cwd", async () => {
    const userDataBaseDir = await temporaryDirectory("missing-project-root");

    expect(() => loadReaderConfig({}, { userDataBaseDir })).toThrowError(
      expect.objectContaining({
        name: "ReaderConfigError",
        setting: "projectRoot",
      }),
    );
    expect(() => loadReaderConfig({}, {
      projectRoot: ".",
      userDataBaseDir,
    })).toThrowError(expect.objectContaining({
      name: "ReaderConfigError",
      setting: "projectRoot",
    }));
  });

  it("uses an OS user-data base namespaced by a SHA-256 project-root id", async () => {
    const projectRoot = await temporaryDirectory("project");
    const userDataBaseDir = await temporaryDirectory("user-data");

    const config = loadReaderConfig({}, { projectRoot, userDataBaseDir });
    const expectedRootId = createHash("sha256").update(projectRoot).digest("hex");

    expect(config).toEqual({
      dataDir: join(userDataBaseDir, "aimd-reader", expectedRootId),
      rootId: expectedRootId,
      retentionDays: 30,
      draftRetentionDays: 90,
      denyGlobs: [],
    });
    expect(relative(projectRoot, config.dataDir).startsWith(".."))
      .toBe(true);
  });

  it("freezes resolved config and issues storage authority only for its exact identity", async () => {
    const projectRoot = await temporaryDirectory("authority-project");
    const userDataBaseDir = await temporaryDirectory("authority-data");
    const config = loadReaderConfig({}, { projectRoot, userDataBaseDir });
    const authorityApi = configModule as typeof configModule & {
      getReaderStorageAuthority?: (value: unknown) => object;
      resolveReaderStorageAuthority?: (value: unknown) => object;
    };

    expect(authorityApi.getReaderStorageAuthority).toBeTypeOf("function");
    expect(authorityApi.resolveReaderStorageAuthority).toBeTypeOf("function");
    const authority = authorityApi.getReaderStorageAuthority!(config);
    const metadata = authorityApi.resolveReaderStorageAuthority!(authority);
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(authority)).toBe(true);
    expect(Object.isFrozen(metadata)).toBe(true);
    expect(() => authorityApi.getReaderStorageAuthority!({ ...config }))
      .toThrow(/authority|identity/iu);
    expect(() => authorityApi.resolveReaderStorageAuthority!({}))
      .toThrow(/authority/iu);
  });

  it("namespaces an explicit absolute AIMD_DATA_DIR and rejects project-local storage", async () => {
    const projectRoot = await temporaryDirectory("explicit-project");
    const externalBase = await temporaryDirectory("explicit-data");

    const config = loadReaderConfig(
      { AIMD_DATA_DIR: externalBase },
      { projectRoot, userDataBaseDir: externalBase },
    );
    expect(config.dataDir).toBe(join(externalBase, config.rootId));

    expect(() => loadReaderConfig(
      { AIMD_DATA_DIR: join(projectRoot, ".aimd") },
      { projectRoot, userDataBaseDir: externalBase },
    )).toThrowError(expect.objectContaining({
      name: "ReaderConfigError",
      setting: "AIMD_DATA_DIR",
    }));
  });

  it("conservatively treats Windows containment as case-insensitive", () => {
    expect(() => loadReaderConfig(
      { AIMD_DATA_DIR: "C:\\root" },
      {
        projectRoot: "C:\\Root",
        platform: "win32",
        userDataBaseDir: "C:\\Users\\reader",
      },
    )).toThrow(/AIMD_DATA_DIR/u);
    expect(() => loadReaderConfig(
      { AIMD_DATA_DIR: "C:\\Root\\private" },
      {
        projectRoot: "C:\\Root",
        platform: "win32",
        userDataBaseDir: "C:\\Users\\reader",
      },
    )).toThrow(/AIMD_DATA_DIR/u);
  });

  it("rejects a data-directory alias whose nearest existing ancestor resolves inside the project", async () => {
    const projectRoot = await temporaryDirectory("aliased-project");
    const externalBase = await temporaryDirectory("aliased-data");
    const projectStorage = join(projectRoot, "private-data");
    const alias = join(externalBase, "data-alias");
    await mkdir(projectStorage);
    await symlink(
      projectStorage,
      alias,
      process.platform === "win32" ? "junction" : "dir",
    );

    expect(() => loadReaderConfig(
      { AIMD_DATA_DIR: alias },
      { projectRoot, userDataBaseDir: externalBase },
    )).toThrowError(expect.objectContaining({
      name: "ReaderConfigError",
      setting: "AIMD_DATA_DIR",
    }));
  });

  it("parses bounded retention values and a strict JSON string-array deny list", async () => {
    const projectRoot = await temporaryDirectory("valid-values");
    const userDataBaseDir = await temporaryDirectory("valid-data");

    expect(loadReaderConfig({
      AIMD_RETENTION_DAYS: "45",
      AIMD_DRAFT_RETENTION_DAYS: "120",
      AIMD_DENY_GLOBS: '["**/*.pem","private/**"]',
    }, { projectRoot, userDataBaseDir })).toMatchObject({
      retentionDays: 45,
      draftRetentionDays: 120,
      denyGlobs: ["**/*.pem", "private/**"],
    });
  });

  it.each([
    ["AIMD_RETENTION_DAYS", "0"],
    ["AIMD_RETENTION_DAYS", "1.5"],
    ["AIMD_RETENTION_DAYS", "3651"],
    ["AIMD_DRAFT_RETENTION_DAYS", "0"],
    ["AIMD_DRAFT_RETENTION_DAYS", "90 days"],
    ["AIMD_DRAFT_RETENTION_DAYS", "3651"],
  ])("reports the invalid setting name for %s=%s", async (setting, value) => {
    const projectRoot = await temporaryDirectory(`invalid-${setting}`);
    const userDataBaseDir = await temporaryDirectory(`invalid-data-${setting}`);

    expect(() => loadReaderConfig(
      { [setting]: value },
      { projectRoot, userDataBaseDir },
    )).toThrow(new RegExp(setting));
  });

  it("requires draft retention to be at least completed-record retention", async () => {
    const projectRoot = await temporaryDirectory("retention-order");
    const userDataBaseDir = await temporaryDirectory("retention-order-data");

    expect(() => loadReaderConfig({
      AIMD_RETENTION_DAYS: "100",
      AIMD_DRAFT_RETENTION_DAYS: "90",
    }, { projectRoot, userDataBaseDir })).toThrow(/AIMD_DRAFT_RETENTION_DAYS/u);
  });

  it.each([
    "not-json",
    "{}",
    '["**/*.pem",42]',
    '[""]',
    '["ok","ok"]',
    JSON.stringify(Array.from({ length: MAX_DENY_GLOBS + 1 }, (_, index) => `p${index}`)),
    JSON.stringify(["x".repeat(MAX_DENY_GLOB_LENGTH + 1)]),
    JSON.stringify(["!**/*.pem"]),
    JSON.stringify(["/etc/**"]),
    JSON.stringify(["C:/Users/private/**"]),
    JSON.stringify(["../private/**"]),
    JSON.stringify(["src/../private/**"]),
    JSON.stringify(["private/\nsecret"]),
    JSON.stringify(Array.from(
      { length: MAX_DENY_GLOBS },
      (_, index) => `${index.toString().padStart(2, "0")}-${"x".repeat(
        Math.ceil(MAX_DENY_GLOBS_BYTES / MAX_DENY_GLOBS) + 1,
      )}`,
    )),
  ])("rejects malformed or unbounded AIMD_DENY_GLOBS: %s", async (value) => {
    const projectRoot = await temporaryDirectory("deny-invalid");
    const userDataBaseDir = await temporaryDirectory("deny-invalid-data");

    expect(() => loadReaderConfig(
      { AIMD_DENY_GLOBS: value },
      { projectRoot, userDataBaseDir },
    )).toThrow(/AIMD_DENY_GLOBS/u);
  });

  it("does not retain malformed deny-glob input in an error cause", async () => {
    const projectRoot = await temporaryDirectory("deny-secret");
    const userDataBaseDir = await temporaryDirectory("deny-secret-data");
    let thrown: unknown;
    try {
      loadReaderConfig(
        { AIMD_DENY_GLOBS: "{\"private-secret\":" },
        { projectRoot, userDataBaseDir },
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ReaderConfigError);
    expect(thrown).toMatchObject({
      setting: "AIMD_DENY_GLOBS",
      message: "Invalid AIMD_DENY_GLOBS: expected a JSON string array",
    });
    expect((thrown as Error & { cause?: unknown }).cause).toBeUndefined();
  });

  it("rejects relative or NUL-containing data directories with a specific config error", async () => {
    const projectRoot = await temporaryDirectory("invalid-dir");
    const userDataBaseDir = await temporaryDirectory("invalid-dir-data");

    for (const value of ["relative/data", `${userDataBaseDir}\0tail`]) {
      try {
        loadReaderConfig(
          { AIMD_DATA_DIR: value },
          { projectRoot, userDataBaseDir },
        );
        throw new Error("expected loadReaderConfig to reject");
      } catch (error) {
        expect(error).toBeInstanceOf(ReaderConfigError);
        expect(error).toMatchObject({ setting: "AIMD_DATA_DIR" });
      }
    }
  });

  it("reports a config error when an absolute path belongs to the wrong platform syntax", () => {
    expect(() => loadReaderConfig(
      { AIMD_DATA_DIR: "/var/lib/aimd" },
      {
        projectRoot: "C:\\Project",
        platform: "win32",
        userDataBaseDir: "C:\\Users\\reader",
      },
    )).toThrowError(expect.objectContaining({
      name: "ReaderConfigError",
      setting: "AIMD_DATA_DIR",
    }));
  });

  it("exports a strict schema for the resolved configuration", async () => {
    const projectRoot = await temporaryDirectory("schema");
    const userDataBaseDir = await temporaryDirectory("schema-data");
    const config = loadReaderConfig({}, { projectRoot, userDataBaseDir });

    expect(ReaderConfigSchema.parse(config)).toEqual(config);
    expect(() => ReaderConfigSchema.parse({ ...config, parentThreadId: "secret" }))
      .toThrow();
  });
});
