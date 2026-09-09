import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { GENERATED_APP_SERVER_SCHEMA_VERSION } from "./generated-protocol.js";
import {
  buildGenerateTypeArguments,
  renderProtocolCompatibilityFacade,
  renderVersionManifest,
  runAppServerTypeGeneration,
  type TypeGenerationDependencies,
} from "./generator.js";

describe("App Server type generation", () => {
  it("uses the resolved CLI's experimental generate-ts command", () => {
    expect(buildGenerateTypeArguments("C:\\Temp\\schema-stage")).toEqual([
      "app-server",
      "generate-ts",
      "--out",
      "C:\\Temp\\schema-stage",
      "--experimental",
    ]);
  });

  it("writes a path-redacted manifest and records host/PATH mismatches", () => {
    const manifest = renderVersionManifest({
      executableBasename: "codex.exe",
      schemaCliVersion: "0.151.0-alpha.7.2",
      desktopVersion: "0.151.0-alpha.7.2",
      pathCliVersion: "0.152.0",
      generatedAt: "2026-09-02T00:00:00.000Z",
    });

    expect(manifest).toContain("Schema CLI: `codex.exe` (path redacted)");
    expect(manifest).toContain("Schema CLI version: `0.151.0-alpha.7.2`");
    expect(manifest).toContain("Desktop/host compatibility: `matched`");
    expect(manifest).toContain("PATH CLI compatibility: `mismatch`");
    expect(manifest).toContain("codex app-server generate-ts --out <generated> --experimental");
    expect(manifest).not.toContain("C:\\Users");
    expect(manifest).not.toContain("AppData");
  });

  it.each([
    "0.152.0\n- Schema CLI: `C:\\Users\\private\\codex.exe`",
    "C:\\Users\\private\\codex.exe",
  ])("rejects manifest-injecting PATH versions", (pathCliVersion) => {
    expect(() => renderVersionManifest({
      executableBasename: "codex.exe",
      schemaCliVersion: "0.151.0-alpha.7.2",
      pathCliVersion,
      generatedAt: "2026-09-02T00:00:00.000Z",
    })).toThrow("APP_SERVER_MANIFEST_VERSION_INVALID");
  });

  it("regenerates the checked-in compatibility facade from the current schema", () => {
    const generated = new URL("../generated/", import.meta.url);
    const read = (path: string) => readFileSync(new URL(path, generated), "utf8");
    const facade = renderProtocolCompatibilityFacade(
      GENERATED_APP_SERVER_SCHEMA_VERSION,
      {
        clientInfo: read("ClientInfo.ts"),
        initializeCapabilities: read("InitializeCapabilities.ts"),
        initializeParams: read("InitializeParams.ts"),
        initializeResponse: read("InitializeResponse.ts"),
        threadReadParams: read("v2/ThreadReadParams.ts"),
        threadForkParams: read("v2/ThreadForkParams.ts"),
        threadStartParams: read("v2/ThreadStartParams.ts"),
        turnStartParams: read("v2/TurnStartParams.ts"),
        turnInterruptParams: read("v2/TurnInterruptParams.ts"),
        thread: read("v2/Thread.ts"),
        turn: read("v2/Turn.ts"),
        askForApproval: read("v2/AskForApproval.ts"),
        sandboxMode: read("v2/SandboxMode.ts"),
        sandboxPolicy: read("v2/SandboxPolicy.ts"),
        userInput: read("v2/UserInput.ts"),
      },
    );
    const versionManifest = read("VERSION.md");

    const normalizedFacade = readFileSync(
      new URL("./generated-protocol.ts", import.meta.url),
      "utf8",
    ).replace(/\r\n?|\n/gu, "\n");
    expect(normalizedFacade).toBe(facade);
    expect(versionManifest).toContain(
      `Schema CLI version: \`${GENERATED_APP_SERVER_SCHEMA_VERSION}\``,
    );
  });

  it("rejects a generated request schema that adds an unbound required field", () => {
    const generated = new URL("../generated/", import.meta.url);
    const read = (path: string) => readFileSync(new URL(path, generated), "utf8");
    const threadStartParams = read("v2/ThreadStartParams.ts").replace(
      "export type ThreadStartParams = {",
      "export type ThreadStartParams = { newlyRequired: string,",
    );

    expect(() => renderProtocolCompatibilityFacade(
      GENERATED_APP_SERVER_SCHEMA_VERSION,
      {
        clientInfo: read("ClientInfo.ts"),
        initializeCapabilities: read("InitializeCapabilities.ts"),
        initializeParams: read("InitializeParams.ts"),
        initializeResponse: read("InitializeResponse.ts"),
        threadReadParams: read("v2/ThreadReadParams.ts"),
        threadForkParams: read("v2/ThreadForkParams.ts"),
        threadStartParams,
        turnStartParams: read("v2/TurnStartParams.ts"),
        turnInterruptParams: read("v2/TurnInterruptParams.ts"),
        thread: read("v2/Thread.ts"),
        turn: read("v2/Turn.ts"),
        askForApproval: read("v2/AskForApproval.ts"),
        sandboxMode: read("v2/SandboxMode.ts"),
        sandboxPolicy: read("v2/SandboxPolicy.ts"),
        userInput: read("v2/UserInput.ts"),
      },
    )).toThrow("APP_SERVER_SCHEMA_CONTRACT_UNSUPPORTED");
  });

  it.each([
    {
      name: "ClientInfo",
      path: "ClientInfo.ts",
      mutate: (source: string) => source.replace(
        "export type ClientInfo = {",
        "export type ClientInfo = { newlyRequired: string,",
      ),
    },
    {
      name: "InitializeCapabilities",
      path: "InitializeCapabilities.ts",
      mutate: (source: string) => source.replace(
        "export type InitializeCapabilities = {",
        "export type InitializeCapabilities = { newlyRequired: string,",
      ),
    },
    {
      name: "UserInput text",
      path: "v2/UserInput.ts",
      mutate: (source: string) => source.replace(
        'export type UserInput = { "type": "text",',
        'export type UserInput = { "type": "text", newlyRequired: string,',
      ),
    },
    {
      name: "SandboxPolicy readOnly",
      path: "v2/SandboxPolicy.ts",
      mutate: (source: string) => source.replace(
        '{ "type": "readOnly",',
        '{ "type": "readOnly", newlyRequired: string,',
      ),
    },
  ])("rejects a nested required field added to $name", ({ path, mutate }) => {
    const generated = new URL("../generated/", import.meta.url);
    const read = (file: string) => readFileSync(new URL(file, generated), "utf8");
    const sources = {
      clientInfo: read("ClientInfo.ts"),
      initializeCapabilities: read("InitializeCapabilities.ts"),
      initializeParams: read("InitializeParams.ts"),
      initializeResponse: read("InitializeResponse.ts"),
      threadReadParams: read("v2/ThreadReadParams.ts"),
      threadForkParams: read("v2/ThreadForkParams.ts"),
      threadStartParams: read("v2/ThreadStartParams.ts"),
      turnStartParams: read("v2/TurnStartParams.ts"),
      turnInterruptParams: read("v2/TurnInterruptParams.ts"),
      thread: read("v2/Thread.ts"),
      turn: read("v2/Turn.ts"),
      askForApproval: read("v2/AskForApproval.ts"),
      sandboxMode: read("v2/SandboxMode.ts"),
      sandboxPolicy: read("v2/SandboxPolicy.ts"),
      userInput: read("v2/UserInput.ts"),
    };
    if (path === "ClientInfo.ts") sources.clientInfo = mutate(sources.clientInfo);
    if (path === "InitializeCapabilities.ts") {
      sources.initializeCapabilities = mutate(sources.initializeCapabilities);
    }
    if (path === "v2/UserInput.ts") sources.userInput = mutate(sources.userInput);
    if (path === "v2/SandboxPolicy.ts") sources.sandboxPolicy = mutate(sources.sandboxPolicy);

    expect(() => renderProtocolCompatibilityFacade(
      GENERATED_APP_SERVER_SCHEMA_VERSION,
      sources,
    )).toThrow("APP_SERVER_SCHEMA_CONTRACT_UNSUPPORTED");
  });

  it("publishes generated files only after the resolved CLI exits zero", async () => {
    const calls: string[] = [];
    const dependencies: TypeGenerationDependencies = {
      createStage: async () => "C:\\Temp\\schema-stage",
      run: async (executable, args) => {
        calls.push(`${executable}|${args.join("|")}`);
        return 0;
      },
      writeManifest: async (_stage, manifest) => {
        calls.push(`manifest:${manifest.length}`);
      },
      publish: async (stage, output) => {
        calls.push(`publish:${stage}|${output}`);
      },
      discard: async () => {
        calls.push("discard");
      },
    };

    await runAppServerTypeGeneration(
      {
        executablePath: "C:\\Desktop\\codex.exe",
        outputDirectory: "D:\\Project\\AIMD\\packages\\app-server-bridge\\generated",
        manifest: {
          executableBasename: "codex.exe",
          schemaCliVersion: "0.151.0-alpha.7.2",
          generatedAt: "2026-09-02T00:00:00.000Z",
        },
      },
      dependencies,
    );

    expect(calls[0]).toBe(
      "C:\\Desktop\\codex.exe|app-server|generate-ts|--out|C:\\Temp\\schema-stage|--experimental",
    );
    expect(calls.at(-1)).toContain("publish:");
    expect(calls).not.toContain("discard");
  });

  it("fails nonzero generation and never publishes partial output", async () => {
    const calls: string[] = [];
    const dependencies: TypeGenerationDependencies = {
      createStage: async () => "C:\\Temp\\schema-stage",
      run: async () => 23,
      writeManifest: async () => {
        calls.push("manifest");
      },
      publish: async () => {
        calls.push("publish");
      },
      discard: async () => {
        calls.push("discard");
      },
    };

    await expect(
      runAppServerTypeGeneration(
        {
          executablePath: "C:\\Desktop\\codex.exe",
          outputDirectory: "D:\\Project\\AIMD\\packages\\app-server-bridge\\generated",
          manifest: {
            executableBasename: "codex.exe",
            schemaCliVersion: "0.151.0-alpha.7.2",
            generatedAt: "2026-09-02T00:00:00.000Z",
          },
        },
        dependencies,
      ),
    ).rejects.toThrow("APP_SERVER_SCHEMA_GENERATION_FAILED");
    expect(calls).toEqual(["discard"]);
  });
});
