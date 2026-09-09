import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

const MANIFEST_VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/u;
const STAGED_FACADE = ".aimd-generated-protocol.ts";

export type ProtocolFacadeSources = {
  clientInfo: string;
  initializeCapabilities: string;
  initializeParams: string;
  initializeResponse: string;
  threadReadParams: string;
  threadForkParams: string;
  threadStartParams: string;
  turnStartParams: string;
  turnInterruptParams: string;
  thread: string;
  turn: string;
  askForApproval: string;
  sandboxMode: string;
  sandboxPolicy: string;
  userInput: string;
};

export type VersionManifestInput = {
  executableBasename: "codex" | "codex.exe";
  schemaCliVersion: string;
  desktopVersion?: string;
  pathCliVersion?: string;
  generatedAt: string;
};

export type TypeGenerationInput = {
  executablePath: string;
  outputDirectory: string;
  manifest: VersionManifestInput;
};

export interface TypeGenerationDependencies {
  createStage(outputDirectory: string): Promise<string>;
  run(executable: string, args: readonly string[]): Promise<number | null>;
  writeManifest(stageDirectory: string, manifest: string): Promise<void>;
  publish(stageDirectory: string, outputDirectory: string): Promise<void>;
  discard(stageDirectory: string): Promise<void>;
}

function compatibility(actual: string, expected?: string): "matched" | "mismatch" | "not_provided" {
  if (!expected) return "not_provided";
  return actual === expected ? "matched" : "mismatch";
}

function checkedManifestVersion(value: string | undefined, required: boolean): string | undefined {
  if (value === undefined && !required) return undefined;
  if (value === undefined || !MANIFEST_VERSION.test(value)) {
    throw new Error("APP_SERVER_MANIFEST_VERSION_INVALID");
  }
  return value;
}

function requireSchemaTokens(source: string, tokens: readonly string[]): void {
  if (tokens.some((token) => !source.includes(token))) {
    throw new Error("APP_SERVER_SCHEMA_CONTRACT_UNSUPPORTED");
  }
}

function requiredTypeLiteralProperties(source: string, typeName: string): string[] {
  const withoutComments = source
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .replace(/\/\/[^\r\n]*/gu, "");
  const marker = `export type ${typeName} = {`;
  const markerIndex = withoutComments.indexOf(marker);
  if (markerIndex < 0) throw new Error("APP_SERVER_SCHEMA_CONTRACT_UNSUPPORTED");
  const bodyStart = markerIndex + marker.length;
  const required: string[] = [];
  let depth = 1;
  let segmentStart = bodyStart;
  const consume = (end: number) => {
    const segment = withoutComments.slice(segmentStart, end).trim();
    const property = /^(?:"([^"]+)"|([A-Za-z_$][A-Za-z0-9_$]*))(\?)?\s*:/u.exec(segment);
    if (property && property[3] !== "?") {
      const name = property[1] ?? property[2];
      if (name) required.push(name);
    }
  };
  for (let index = bodyStart; index < withoutComments.length; index += 1) {
    const character = withoutComments[index];
    if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        consume(index);
        return required;
      }
    } else if (character === "," && depth === 1) {
      consume(index);
      segmentStart = index + 1;
    }
  }
  throw new Error("APP_SERVER_SCHEMA_CONTRACT_UNSUPPORTED");
}

function requireExactRequiredProperties(
  source: string,
  typeName: string,
  expected: readonly string[],
): void {
  const actual = requiredTypeLiteralProperties(source, typeName).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((name, index) => name !== wanted[index])) {
    throw new Error("APP_SERVER_SCHEMA_CONTRACT_UNSUPPORTED");
  }
}

function requiredDiscriminatedVariantProperties(
  source: string,
  typeName: string,
  discriminantValue: string,
): string[] {
  const withoutComments = source
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .replace(/\/\/[^\r\n]*/gu, "");
  const aliasIndex = withoutComments.indexOf(`export type ${typeName} =`);
  if (aliasIndex < 0) throw new Error("APP_SERVER_SCHEMA_CONTRACT_UNSUPPORTED");
  const marker = `{ "type": "${discriminantValue}"`;
  const variantIndex = withoutComments.indexOf(marker, aliasIndex);
  if (variantIndex < 0) throw new Error("APP_SERVER_SCHEMA_CONTRACT_UNSUPPORTED");
  return requiredTypeLiteralProperties(
    `export type SelectedVariant = ${withoutComments.slice(variantIndex)}`,
    "SelectedVariant",
  );
}

function requireExactDiscriminatedVariantProperties(
  source: string,
  typeName: string,
  discriminantValue: string,
  expected: readonly string[],
): void {
  const actual = requiredDiscriminatedVariantProperties(
    source,
    typeName,
    discriminantValue,
  ).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((name, index) => name !== wanted[index])) {
    throw new Error("APP_SERVER_SCHEMA_CONTRACT_UNSUPPORTED");
  }
}

export function buildGenerateTypeArguments(outputDirectory: string): string[] {
  return ["app-server", "generate-ts", "--out", outputDirectory, "--experimental"];
}

export function renderVersionManifest(input: VersionManifestInput): string {
  const schemaCliVersion = checkedManifestVersion(input.schemaCliVersion, true) as string;
  const desktopVersion = checkedManifestVersion(input.desktopVersion, false);
  const pathCliVersion = checkedManifestVersion(input.pathCliVersion, false);
  const desktopCompatibility = compatibility(schemaCliVersion, desktopVersion);
  const pathCompatibility = compatibility(schemaCliVersion, pathCliVersion);
  return [
    "# Codex App Server generated protocol",
    "",
    "This directory is generated. Do not edit protocol files by hand.",
    "",
    `- Schema CLI: \`${input.executableBasename}\` (path redacted)`,
    `- Schema CLI version: \`${schemaCliVersion}\``,
    `- Schema command: \`codex app-server generate-ts --out <generated> --experimental\``,
    `- Generated at: \`${input.generatedAt}\``,
    `- Desktop/host version: \`${desktopVersion ?? "not provided"}\``,
    `- Desktop/host compatibility: \`${desktopCompatibility}\``,
    `- PATH CLI version: \`${pathCliVersion ?? "not detected"}\``,
    `- PATH CLI compatibility: \`${pathCompatibility}\``,
    "",
  ].join("\n");
}

export function renderProtocolCompatibilityFacade(
  schemaVersion: string,
  sources: ProtocolFacadeSources,
): string {
  const version = checkedManifestVersion(schemaVersion, true) as string;
  requireExactRequiredProperties(sources.clientInfo, "ClientInfo", ["name", "title", "version"]);
  requireExactRequiredProperties(
    sources.initializeCapabilities,
    "InitializeCapabilities",
    ["experimentalApi", "requestAttestation"],
  );
  requireExactRequiredProperties(
    sources.initializeParams,
    "InitializeParams",
    ["clientInfo", "capabilities"],
  );
  requireExactRequiredProperties(sources.threadReadParams, "ThreadReadParams", ["threadId"]);
  requireExactRequiredProperties(sources.threadForkParams, "ThreadForkParams", ["threadId"]);
  requireExactRequiredProperties(sources.threadStartParams, "ThreadStartParams", []);
  requireExactRequiredProperties(sources.turnStartParams, "TurnStartParams", ["threadId", "input"]);
  requireExactRequiredProperties(
    sources.turnInterruptParams,
    "TurnInterruptParams",
    ["threadId", "turnId"],
  );
  requireExactDiscriminatedVariantProperties(
    sources.userInput,
    "UserInput",
    "text",
    ["type", "text", "text_elements"],
  );
  requireExactDiscriminatedVariantProperties(
    sources.sandboxPolicy,
    "SandboxPolicy",
    "readOnly",
    ["type", "networkAccess"],
  );
  requireSchemaTokens(sources.clientInfo, [
    "name: string",
    "title: string | null",
    "version: string",
  ]);
  requireSchemaTokens(sources.initializeCapabilities, [
    "experimentalApi: boolean",
    "requestAttestation: boolean",
  ]);
  requireSchemaTokens(sources.initializeParams, ["clientInfo:", "capabilities:"]);
  requireSchemaTokens(sources.initializeResponse, [
    "userAgent: string",
    "codexHome:",
    "platformFamily: string",
    "platformOs: string",
  ]);
  requireSchemaTokens(sources.threadReadParams, ["threadId: string", "includeTurns?: boolean"]);
  requireSchemaTokens(sources.threadForkParams, [
    "threadId: string",
    "lastTurnId?: string | null",
    "cwd?: string | null",
    "runtimeWorkspaceRoots?:",
    "approvalPolicy?: AskForApproval | null",
    "sandbox?: SandboxMode | null",
    "config?:",
    "developerInstructions?: string | null",
    "ephemeral?: boolean",
    "deferGoalContinuation?: boolean",
  ]);
  requireSchemaTokens(sources.threadStartParams, [
    "cwd?: string | null",
    "runtimeWorkspaceRoots?:",
    "approvalPolicy?: AskForApproval | null",
    "sandbox?: SandboxMode | null",
    "config?:",
    "developerInstructions?: string | null",
    "ephemeral?: boolean | null",
    "environments?:",
    "dynamicTools?:",
    "selectedCapabilityRoots?:",
  ]);
  requireSchemaTokens(sources.turnStartParams, [
    "threadId: string",
    "input: Array<UserInput>",
    "environments?:",
    "cwd?: string | null",
    "runtimeWorkspaceRoots?:",
    "approvalPolicy?: AskForApproval | null",
    "sandboxPolicy?: SandboxPolicy | null",
    "outputSchema?: JsonValue | null",
  ]);
  requireSchemaTokens(sources.turnInterruptParams, ["threadId: string", "turnId: string"]);
  requireSchemaTokens(sources.thread, [
    "id: string",
    "forkedFromId: string | null",
    "ephemeral: boolean",
    "status: ThreadStatus",
    "cwd: AbsolutePathBuf",
    "turns: Array<Turn>",
  ]);
  requireSchemaTokens(sources.turn, [
    "id: string",
    "items: Array<ThreadItem>",
    "status: TurnStatus",
    "startedAt: number | null",
    "completedAt: number | null",
  ]);
  requireSchemaTokens(sources.askForApproval, ['"never"']);
  requireSchemaTokens(sources.sandboxMode, ['"read-only"']);
  requireSchemaTokens(sources.sandboxPolicy, ['"type": "readOnly"', "networkAccess: boolean"]);
  requireSchemaTokens(sources.userInput, ['"type": "text"', "text: string", "text_elements:"]);

  return `// GENERATED COMPATIBILITY FACADE. DO NOT EDIT BY HAND.
// Source: Codex App Server schema recorded in ../generated/VERSION.md.

export const GENERATED_APP_SERVER_SCHEMA_VERSION = "${version}" as const;

export type GeneratedJsonValue =
  | null
  | boolean
  | number
  | string
  | GeneratedJsonValue[]
  | { [key: string]: GeneratedJsonValue | undefined };

export type GeneratedInitializeParamsAdapter = {
  clientInfo: { name: string; title: string | null; version: string };
  capabilities: {
    experimentalApi: boolean;
    requestAttestation: boolean;
    mcpServerOpenaiFormElicitation?: boolean;
    optOutNotificationMethods?: string[] | null;
    extensions?: { [key: string]: GeneratedJsonValue | undefined } | null;
  } | null;
};

export type GeneratedInitializeResponseAdapter = {
  userAgent: string;
  codexHome: string;
  platformFamily: string;
  platformOs: string;
};

export type GeneratedThreadReadParamsAdapter = {
  threadId: string;
  includeTurns?: boolean;
};

export type GeneratedThreadForkParamsAdapter = {
  threadId: string;
  lastTurnId?: string | null;
  cwd?: string | null;
  runtimeWorkspaceRoots?: string[] | null;
  approvalPolicy?: "never" | null;
  sandbox?: "read-only" | null;
  config?: { [key: string]: GeneratedJsonValue | undefined } | null;
  developerInstructions?: string | null;
  ephemeral?: boolean;
  deferGoalContinuation?: boolean;
};

export type GeneratedThreadStartParamsAdapter = {
  cwd?: string | null;
  runtimeWorkspaceRoots?: string[] | null;
  approvalPolicy?: "never" | null;
  sandbox?: "read-only" | null;
  config?: { [key: string]: GeneratedJsonValue | undefined } | null;
  developerInstructions?: string | null;
  ephemeral?: boolean | null;
  environments?: unknown[] | null;
  dynamicTools?: unknown[] | null;
  selectedCapabilityRoots?: unknown[] | null;
};

export type GeneratedTurnStartParamsAdapter = {
  threadId: string;
  input: Array<{ type: "text"; text: string; text_elements: unknown[] }>;
  environments?: unknown[] | null;
  cwd?: string | null;
  runtimeWorkspaceRoots?: string[] | null;
  approvalPolicy?: "never" | null;
  sandboxPolicy?: { type: "readOnly"; networkAccess: boolean } | null;
  outputSchema?: GeneratedJsonValue | null;
};

export type GeneratedTurnInterruptParamsAdapter = {
  threadId: string;
  turnId: string;
};

export type GeneratedTurnStatusAdapter =
  | "completed"
  | "interrupted"
  | "failed"
  | "inProgress";

export type GeneratedTurnAdapter = {
  id: string;
  status: GeneratedTurnStatusAdapter;
  items: unknown[];
  startedAt: number | null;
  completedAt: number | null;
};

export type GeneratedThreadAdapter = {
  id: string;
  cwd: string;
  ephemeral: boolean;
  forkedFromId: string | null;
  status: { type: string };
  turns: GeneratedTurnAdapter[];
};

export type GeneratedThreadResponseAdapter = { thread: GeneratedThreadAdapter };
export type GeneratedTurnStartResponseAdapter = { turn: GeneratedTurnAdapter };
`;
}

function assertGeneratedOutputTarget(outputDirectory: string): void {
  const absolute = resolve(outputDirectory);
  if (basename(absolute) !== "generated" || basename(dirname(absolute)) !== "app-server-bridge") {
    throw new Error("APP_SERVER_SCHEMA_OUTPUT_INVALID");
  }
}

async function readProtocolFacadeSources(directory: string): Promise<ProtocolFacadeSources> {
  const read = (path: string) => readFile(join(directory, path), "utf8");
  const [
    clientInfo,
    initializeCapabilities,
    initializeParams,
    initializeResponse,
    threadReadParams,
    threadForkParams,
    threadStartParams,
    turnStartParams,
    turnInterruptParams,
    thread,
    turn,
    askForApproval,
    sandboxMode,
    sandboxPolicy,
    userInput,
  ] = await Promise.all([
    read("ClientInfo.ts"),
    read("InitializeCapabilities.ts"),
    read("InitializeParams.ts"),
    read("InitializeResponse.ts"),
    read("v2/ThreadReadParams.ts"),
    read("v2/ThreadForkParams.ts"),
    read("v2/ThreadStartParams.ts"),
    read("v2/TurnStartParams.ts"),
    read("v2/TurnInterruptParams.ts"),
    read("v2/Thread.ts"),
    read("v2/Turn.ts"),
    read("v2/AskForApproval.ts"),
    read("v2/SandboxMode.ts"),
    read("v2/SandboxPolicy.ts"),
    read("v2/UserInput.ts"),
  ]);
  return {
    clientInfo,
    initializeCapabilities,
    initializeParams,
    initializeResponse,
    threadReadParams,
    threadForkParams,
    threadStartParams,
    turnStartParams,
    turnInterruptParams,
    thread,
    turn,
    askForApproval,
    sandboxMode,
    sandboxPolicy,
    userInput,
  };
}

function schemaVersionFromManifest(manifest: string): string {
  const match = /^- Schema CLI version: `([^`]+)`$/mu.exec(manifest);
  return checkedManifestVersion(match?.[1], true) as string;
}

export const defaultTypeGenerationDependencies: TypeGenerationDependencies = {
  async createStage(outputDirectory) {
    assertGeneratedOutputTarget(outputDirectory);
    return mkdtemp(join(dirname(resolve(outputDirectory)), ".app-server-schema-"));
  },
  async run(executable, args) {
    const result = spawnSync(executable, [...args], {
      stdio: ["ignore", "ignore", "ignore"],
      windowsHide: true,
      timeout: 120_000,
    });
    return result.status;
  },
  async writeManifest(stageDirectory, manifest) {
    const indexPath = join(stageDirectory, "index.ts");
    if (!(await stat(indexPath)).isFile()) {
      throw new Error("APP_SERVER_SCHEMA_OUTPUT_MISSING");
    }
    await writeFile(join(stageDirectory, "VERSION.md"), manifest, "utf8");
    await writeFile(
      join(stageDirectory, STAGED_FACADE),
      renderProtocolCompatibilityFacade(
        schemaVersionFromManifest(manifest),
        await readProtocolFacadeSources(stageDirectory),
      ),
      "utf8",
    );
  },
  async publish(stageDirectory, outputDirectory) {
    assertGeneratedOutputTarget(outputDirectory);
    const facade = await readFile(join(stageDirectory, STAGED_FACADE), "utf8");
    await rm(join(stageDirectory, STAGED_FACADE), { force: true });
    await rm(outputDirectory, { recursive: true, force: true });
    await rename(stageDirectory, outputDirectory);
    await writeFile(
      join(dirname(outputDirectory), "src", "generated-protocol.ts"),
      facade,
      "utf8",
    );
  },
  async discard(stageDirectory) {
    await rm(stageDirectory, { recursive: true, force: true });
  },
};

export async function runAppServerTypeGeneration(
  input: TypeGenerationInput,
  dependencies: TypeGenerationDependencies = defaultTypeGenerationDependencies,
): Promise<void> {
  const stageDirectory = await dependencies.createStage(input.outputDirectory);
  let published = false;
  try {
    const status = await dependencies.run(
      input.executablePath,
      buildGenerateTypeArguments(stageDirectory),
    );
    if (status !== 0) throw new Error("APP_SERVER_SCHEMA_GENERATION_FAILED");
    await dependencies.writeManifest(stageDirectory, renderVersionManifest(input.manifest));
    await dependencies.publish(stageDirectory, input.outputDirectory);
    published = true;
  } finally {
    if (!published) await dependencies.discard(stageDirectory);
  }
}
