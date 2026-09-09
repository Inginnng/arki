import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type GeneratedVersionFacts = {
  readonly schemaCliBasename: "codex" | "codex.exe";
  readonly schemaCliVersion: string;
  readonly desktopVersion: string;
  readonly desktopCompatibility: "matched" | "mismatch";
  readonly pathCliVersion: string;
  readonly pathCompatibility: "matched" | "mismatch";
};

export type ExecutablePreflight = {
  readonly source: "direct_executable_lookup" | "verified_host_hint" | "environment";
  readonly status: "compatible" | "version_mismatch" | "incompatible" | "unavailable";
  readonly observedVersion?: string;
  readonly expectedDesktopVersion: string;
  readonly appServerSurface: "available" | "unavailable" | "not_checked";
  readonly code?: "INVALID_EXECUTABLE" | "VERSION_UNAVAILABLE" | "APP_SERVER_UNAVAILABLE";
};

export type CapabilityGate = {
  readonly id: "P0-A" | "P0-B" | "P0-C" | "P0-D" | "P0-E";
  readonly status: "passed" | "failed" | "unsupported" | "not_run" | "inconclusive";
  readonly evidence: string;
};

export type SanitizedCapabilityReport = {
  readonly reportVersion: 1;
  readonly observation: "task_10_regression";
  readonly observedOn: "2026-09-04";
  readonly generatedProtocol: GeneratedVersionFacts;
  readonly executablePreflight?: ExecutablePreflight;
  readonly liveDesktopInvocation: {
    readonly performed: false;
    readonly reasonCode: "HOST_METADATA_UNAVAILABLE_IN_CURRENT_TASK";
    readonly inMemoryMcpAppsLoop: "passed_supporting_evidence_only";
  };
  readonly gates: readonly CapabilityGate[];
  readonly featureFlags: {
    readonly task_and_project: false;
    readonly project_only: false;
    readonly reader_only: false;
  };
  readonly safetyBoundary: {
    readonly rawHostMetadataObserved: false;
    readonly publicTaskIdentifierAccepted: false;
    readonly taskDiscoveryAttempted: false;
    readonly cwdFallbackUsed: false;
    readonly modelTurnStarted: false;
    readonly identifiersPersisted: false;
  };
  readonly recoveryChecklist: readonly string[];
};

export type CommandResult = { readonly status: number | null; readonly stdout: string };
export type ReadOnlyCommandRunner = (
  executable: string,
  args: readonly string[],
) => CommandResult;

export type CliArguments = {
  readonly format: "json" | "markdown";
  readonly preflight: boolean;
};

const VERSION_PATTERN = "[0-9A-Za-z][0-9A-Za-z.+-]{0,63}";
const VERSION_MANIFEST_URL = new URL(
  "../../packages/app-server-bridge/generated/VERSION.md",
  import.meta.url,
);

const RECOVERY_CHECKLIST = [
  "Completed: package the local plugin and enable `aimd-reader@aimd-local` from its personal marketplace entry.",
  "Restart Codex desktop so the plugin is present when the next task starts.",
  "Open a new task with `tests/live/fixtures/dirty-project` as the exact project root.",
  "Make the fixture's documented uncommitted sentinel edit, then invoke the app-only probe.",
  "Rerun this sanitized updater and review the new gate evidence before enabling context modes.",
] as const;

const ISSUED_CAPABILITY_REPORTS = new WeakSet<object>();
const ISSUED_GENERATED_VERSION_FACTS = new WeakSet<object>();
const ISSUED_EXECUTABLE_PREFLIGHTS = new WeakSet<object>();
const PREFLIGHT_SOURCES = new Set<ExecutablePreflight["source"]>([
  "direct_executable_lookup",
  "verified_host_hint",
  "environment",
]);

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

function assertIssuedCapabilityReport(report: SanitizedCapabilityReport): void {
  if (!ISSUED_CAPABILITY_REPORTS.has(report)) {
    throw new Error("Capability report was not issued by the standalone builder");
  }
}

function escaped(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function requiredManifestValue(
  manifest: string,
  label: string,
  valuePattern: string,
): string {
  const expression = new RegExp(
    "^- " + escaped(label) + ": `(" + valuePattern + ")`$",
    "mu",
  );
  const value = expression.exec(manifest)?.[1];
  if (!value) throw new Error("Generated version manifest is malformed or not path-redacted");
  return value;
}

export function parseGeneratedVersionManifest(manifest: string): GeneratedVersionFacts {
  const cliMatch = /^- Schema CLI: `((?:codex|codex\.exe))` \(path redacted\)$/mu.exec(manifest);
  if (!cliMatch) throw new Error("Generated version manifest is malformed or not path-redacted");

  const facts: GeneratedVersionFacts = {
    schemaCliBasename: cliMatch[1] as GeneratedVersionFacts["schemaCliBasename"],
    schemaCliVersion: requiredManifestValue(manifest, "Schema CLI version", VERSION_PATTERN),
    desktopVersion: requiredManifestValue(manifest, "Desktop/host version", VERSION_PATTERN),
    desktopCompatibility: requiredManifestValue(
      manifest,
      "Desktop/host compatibility",
      "matched|mismatch",
    ) as GeneratedVersionFacts["desktopCompatibility"],
    pathCliVersion: requiredManifestValue(manifest, "PATH CLI version", VERSION_PATTERN),
    pathCompatibility: requiredManifestValue(
      manifest,
      "PATH CLI compatibility",
      "matched|mismatch",
    ) as GeneratedVersionFacts["pathCompatibility"],
  };
  const expectedDesktopCompatibility = facts.desktopVersion === facts.schemaCliVersion
    ? "matched"
    : "mismatch";
  const expectedPathCompatibility = facts.pathCliVersion === facts.schemaCliVersion
    ? "matched"
    : "mismatch";
  if (
    facts.desktopCompatibility !== expectedDesktopCompatibility ||
    facts.pathCompatibility !== expectedPathCompatibility
  ) {
    throw new Error("Generated version manifest contains inconsistent compatibility facts");
  }
  deepFreeze(facts);
  ISSUED_GENERATED_VERSION_FACTS.add(facts);
  return facts;
}

function issueExecutablePreflight(preflight: ExecutablePreflight): ExecutablePreflight {
  deepFreeze(preflight);
  ISSUED_EXECUTABLE_PREFLIGHTS.add(preflight);
  return preflight;
}

function defaultReadOnlyRunner(executable: string, args: readonly string[]): CommandResult {
  const result = spawnSync(executable, [...args], {
    encoding: "utf8",
    shell: false,
    windowsHide: true,
    timeout: 15_000,
    maxBuffer: 64 * 1_024,
  });
  return {
    status: result.status,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
  };
}

export function runReadOnlyExecutablePreflight(options: {
  readonly executable: string;
  readonly source: ExecutablePreflight["source"];
  readonly expectedDesktopVersion: string;
  readonly run?: ReadOnlyCommandRunner;
}): ExecutablePreflight {
  if (
    !PREFLIGHT_SOURCES.has(options.source) ||
    !new RegExp(`^${VERSION_PATTERN}$`, "u").test(options.expectedDesktopVersion)
  ) {
    throw new TypeError("Executable preflight options are invalid");
  }
  const executableBasename = basename(options.executable).toLowerCase();
  if (executableBasename !== "codex" && executableBasename !== "codex.exe") {
    return issueExecutablePreflight({
      source: options.source,
      status: "unavailable",
      expectedDesktopVersion: options.expectedDesktopVersion,
      appServerSurface: "not_checked",
      code: "INVALID_EXECUTABLE",
    });
  }

  const run = options.run ?? defaultReadOnlyRunner;
  let versionResult: CommandResult;
  try {
    versionResult = run(options.executable, ["--version"]);
  } catch {
    return issueExecutablePreflight({
      source: options.source,
      status: "unavailable",
      expectedDesktopVersion: options.expectedDesktopVersion,
      appServerSurface: "not_checked",
      code: "VERSION_UNAVAILABLE",
    });
  }
  const observedVersion = versionResult.status === 0
    ? new RegExp(`(?:^|\\s)codex-cli\\s+(${VERSION_PATTERN})(?:\\s|$)`, "u")
        .exec(versionResult.stdout)?.[1]
    : undefined;
  if (!observedVersion) {
    return issueExecutablePreflight({
      source: options.source,
      status: "unavailable",
      expectedDesktopVersion: options.expectedDesktopVersion,
      appServerSurface: "not_checked",
      code: "VERSION_UNAVAILABLE",
    });
  }

  let helpResult: CommandResult;
  try {
    helpResult = run(options.executable, ["app-server", "--help"]);
  } catch {
    helpResult = { status: null, stdout: "" };
  }
  const appServerAvailable = helpResult.status === 0 && /(?:^|\s)generate-ts(?:\s|$)/u.test(
    helpResult.stdout,
  );
  if (!appServerAvailable) {
    return issueExecutablePreflight({
      source: options.source,
      status: "incompatible",
      observedVersion,
      expectedDesktopVersion: options.expectedDesktopVersion,
      appServerSurface: "unavailable",
      code: "APP_SERVER_UNAVAILABLE",
    });
  }

  return issueExecutablePreflight({
    source: options.source,
    status: observedVersion === options.expectedDesktopVersion ? "compatible" : "version_mismatch",
    observedVersion,
    expectedDesktopVersion: options.expectedDesktopVersion,
    appServerSurface: "available",
  });
}

export function buildCurrentCapabilityReport(
  generatedProtocol: GeneratedVersionFacts,
  executablePreflight?: ExecutablePreflight,
): SanitizedCapabilityReport {
  if (!ISSUED_GENERATED_VERSION_FACTS.has(generatedProtocol)) {
    throw new Error("Generated version facts were not issued by the manifest parser");
  }
  if (executablePreflight && !ISSUED_EXECUTABLE_PREFLIGHTS.has(executablePreflight)) {
    throw new Error("Executable preflight was not issued by the read-only runner");
  }
  if (
    executablePreflight &&
    executablePreflight.expectedDesktopVersion !== generatedProtocol.desktopVersion
  ) {
    throw new Error("Executable preflight does not match the generated desktop version");
  }
  const report: SanitizedCapabilityReport = {
    reportVersion: 1,
    observation: "task_10_regression",
    observedOn: "2026-09-04",
    generatedProtocol,
    ...(executablePreflight ? { executablePreflight } : {}),
    liveDesktopInvocation: {
      performed: false,
      reasonCode: "HOST_METADATA_UNAVAILABLE_IN_CURRENT_TASK",
      inMemoryMcpAppsLoop: "passed_supporting_evidence_only",
    },
    gates: [
      {
        id: "P0-A",
        status: "inconclusive",
        evidence: "The packaged resource, fullscreen request, and app-only tool path passed deterministic MCP and browser tests; this is not live desktop attestation.",
      },
      {
        id: "P0-B",
        status: "unsupported",
        evidence: "The current task did not expose trusted raw CallTool metadata to the app-only probe, so exact task binding was not claimed.",
      },
      {
        id: "P0-C",
        status: "unsupported",
        evidence: "An exact ephemeral fork cannot be proven without the trusted binding required by P0-B.",
      },
      {
        id: "P0-D",
        status: "unsupported",
        evidence: "The local two-citation reader pipeline passed, but no live side question was started without host-proven isolation and exact metadata.",
      },
      {
        id: "P0-E",
        status: "passed",
        evidence: "Deterministic regressions fail closed for missing metadata, binding mismatch, active turns, root replacement, version mismatch, server shutdown, stale evidence, and fabricated citations.",
      },
    ],
    featureFlags: {
      task_and_project: false,
      project_only: false,
      reader_only: false,
    },
    safetyBoundary: {
      rawHostMetadataObserved: false,
      publicTaskIdentifierAccepted: false,
      taskDiscoveryAttempted: false,
      cwdFallbackUsed: false,
      modelTurnStarted: false,
      identifiersPersisted: false,
    },
    recoveryChecklist: RECOVERY_CHECKLIST,
  };
  deepFreeze(report);
  ISSUED_CAPABILITY_REPORTS.add(report);
  return report;
}

export function assertSanitizedProbeOutput(output: string): void {
  const forbidden = [
    /[A-Za-z]:[\\/]/u,
    /\\\\[^\\\s]+\\/u,
    /\/(?:Users|home)\//u,
    /\b(?:thr|turn|item|session)_[A-Za-z0-9_-]+\b/u,
    /(?:openai|codex)\/(?:thread|turn|item|session)Id/iu,
    /(?:^|[\s"'(])\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+(?:$|[\s"'),.;:])/u,
  ];
  if (forbidden.some((pattern) => pattern.test(output))) {
    throw new Error("Capability output failed sanitization");
  }
}

export function renderCapabilityReportJson(report: SanitizedCapabilityReport): string {
  assertIssuedCapabilityReport(report);
  const output = `${JSON.stringify(report, null, 2)}\n`;
  assertSanitizedProbeOutput(output);
  return output;
}

export function renderCapabilityReportMarkdown(report: SanitizedCapabilityReport): string {
  assertIssuedCapabilityReport(report);
  const facts = report.generatedProtocol;
  const lines = [
    "# AIMD capability report",
    "",
    "> Current result: **degraded**. The packaged reader and project-grounded local pipeline are verified, but live exact-task context remains unsupported until a Codex desktop task supplies trusted app-only host metadata.",
    "",
    `Observed on: ${report.observedOn}`,
    "",
    "## Arki · 一览 workspace — 2026-09-08",
    "",
    "Arki adds one-click project analysis, synchronized architecture Markdown and diagrams, whole-architecture questions and selectable typical scenarios, and per-project restoration of the last 20 completed architecture answers with evidence excerpts. The production launcher reuses the same project backend or starts an independent local process with bounded crash recovery. The production application shell and rendered diagram support offline reopening after a successful first load; current source inspection and AI still require the backend. Reconnection refreshes server-issued root IDs, and architecture requests verify a project digest. This does not enable exact desktop-task inheritance or claim complete codebase coverage. See [current verification](inline-reading-status.zh-CN.md).",
    "",
    "## Local web workbenches — 2026-09-07",
    "",
    "The local architecture workbench uses React Flow with ELK layout. The component view represents evidence-backed subsystem containment, including nested groups; the flow view overlays selectable evidenced scenarios on the same component positions. Independent steps preserve repeated participants, conditions, parallel branches, joins, returns and retries. Invalid scenario references are isolated with diagnostics, while geometry failures retain readable component and transfer directories. Transfers carry payload, mechanism, receiver processing and result. Whole-project analysis performs a bounded AI reading-plan pass, reads the selected implementations through guarded workspace APIs, and then authors a fresh graph independently of the package/import seed. Citation IDs are constrained to the current evidence set during generation. Component, subsystem and relationship selection, code inspection, edits, undo/redo, browser persistence, offline reopening, themes and standalone two-view HTML export are implemented. Existing records remain readable and offer explicit re-analysis. Architecture open, analysis, edits and explanations return validated graph data without requiring an Archify artifact. Legacy rendering is optional in saved views; only the explicit compatibility export calls Archify. Its receipts do not validate the React Flow canvas. No architecture action writes project sources or inherits the desktop task.",
    "",
    "Architecture service regressions cover selected-object updates, connected additions, source changes, unissued evidence, path traversal, cancellation and successful graph operations despite legacy composition failures. Browser coverage exercises actual React Flow/ELK rendering with explicit model fixtures; compatibility tests retain Archify coverage. Two controlled live Codex samples succeeded on reader-ui: one refined the selected rectangle; the other added a React-mount node and its relationship from code evidence, preserving all existing objects. The second sample also passed browser undo, redo, reload and standalone HTML export. These establish functional live samples, not general model accuracy or complete architecture coverage. Explicit legacy Archify exports retain nine checks with zero errors and warnings; those checks do not gate the workbench or its ELK HTML export. The component and scenario views have distinct semantics with identical component geometry. Every scenario, step and transition remains available in the reader, document and offline export. New scenarios do not depend on the legacy acyclic narrative or Archify checks. A controlled public synthetic run generated three scenarios with repeated participants in two model calls; this is a functional sample, not coverage or general accuracy certification. Model evidence is balanced across module implementations (up to 24 excerpts); static dependencies remain distinct from calls/data transfers. Exact desktop task binding and the existing packaged capability flags below remain unchanged. Current run results are recorded in [workbench verification](inline-reading-status.zh-CN.md).",
    "",
"## Separate local web side questions — 2026-09-05",
    "",
    "Two controlled live feasibility samples passed with Codex CLI 0.153.3; they are not an end-to-end web acceptance. The Chinese web entry now has explicit task selection and a read-only selected-discussion question path in source code. Real-project model acceptance is pending data-transmission permission. See [Chinese implementation status](web-side-question-status.zh-CN.md) and [live feasibility report](side-question-test-report.zh-CN.md).",
    "",
    "This separate mode does not enable the packaged feature flags below, establish exact desktop-task binding or strict tool isolation, or provide independent semantic review, durable side-chat history, or reviewed document writes. The version and gate sections below retain the earlier packaged-probe observations, not the current installed runtime inventory.",
    "",
    "## Version facts",
    "",
    `- Generated schema CLI: \`${facts.schemaCliBasename}\` \`${facts.schemaCliVersion}\` (path redacted).`,
    `- Desktop/host compatibility: \`${facts.desktopVersion}\` — \`${facts.desktopCompatibility}\`.`,
    `- PATH CLI compatibility: \`${facts.pathCliVersion}\` — \`${facts.pathCompatibility}\`.`,
    "- The generated protocol came from the desktop-matched CLI. The newer PATH CLI was not substituted for it.",
    "",
  ];

  if (report.executablePreflight) {
    const preflight = report.executablePreflight;
    lines.push(
      "## Read-only executable preflight",
      "",
      `- Source: \`${preflight.source}\` (executable path omitted).`,
      `- Status: \`${preflight.status}\`.`,
      `- Observed version: \`${preflight.observedVersion ?? "unavailable"}\`.`,
      `- App Server surface: \`${preflight.appServerSurface}\`.`,
      "- This preflight runs only version and App Server help commands; it cannot upgrade a live gate.",
      "",
    );
  }

  lines.push(
    "## Gate results",
    "",
    "| Gate | Status | Sanitized evidence |",
    "| --- | --- | --- |",
    ...report.gates.map((gate) => `| ${gate.id} | ${gate.status} | ${gate.evidence} |`),
    "",
    "P0-A's deterministic transport and browser results are supporting evidence only; they are not a live desktop pass and cannot enable `reader_only`. P0-B through P0-D are explicitly unsupported in the current task. P0-E records deterministic fail-closed regression coverage, not a substitute for live context fidelity.",
    "",
    "## Feature flags",
    "",
    `- task_and_project: \`${report.featureFlags.task_and_project}\``,
    `- project_only: \`${report.featureFlags.project_only}\``,
    `- reader_only: \`${report.featureFlags.reader_only}\``,
    "",
    "## Enforced safety boundary",
    "",
    "- No real hidden host metadata was available to this already-running task.",
    "- The updater accepts no public task identifier or workspace path.",
    "- It performs no task discovery and uses no current-directory fallback.",
    "- It starts no model turn because the host has not proven an empty effective tool surface.",
    "- It stores no task or turn identifiers and emits no absolute executable path.",
    "",
    "## Locally verified implementation",
    "",
    "- The production plugin contains one self-contained reader resource and one bundled server resource, with no runtime node_modules dependency.",
    "- The filesystem-backed service flow validates two current code citations, persists only reviewed answers, requires an explicit disposition, previews an exact diff, and writes a sibling explained document without overwriting its source.",
    "- Browser smoke tests complete the keyboard question, source peek, disposition, diff approval, and write-success path at 1280 by 800 and 1600 by 1000 with no browser console errors.",
    "- The 20-question deterministic accuracy corpus validates fixture coverage, citation and refusal checks, unique independent-run session keys, and shared continuity-session topology. It does not measure real-model correctness or prove real Codex task or process isolation.",
    "- Browser screenshots were captured, but direct image inspection in this host was blocked by the Windows CUA kernel asset-path failure; this remains an explicit manual visual-review item.",
    "",
    "## Isolated adapter boundary",
    "",
    "- Hidden host metadata is reduced only by HostContextExtractor, then verified through ContextBridge and the generated App Server client. If the host metadata contract changes, this adapter boundary is the only component that should require protocol-specific changes.",
    "",
    "## Initial Phase 0 history",
    "",
    "On 2026-09-02, P0-A was inconclusive and P0-B through P0-E were not_run because the plugin was not present at task start. No reader or context feature flag was enabled. This history is retained; the Task 10 evidence above does not rewrite it.",
    "",
    "## Recovery checklist",
    "",
    ...report.recoveryChecklist.map((item, index) => `${index + 1}. ${item}`),
    "",
    "Until those steps succeed, the packaged capability probe must keep exact task context disabled and present project-only degradation honestly.",
    "",
    "> Public distribution: Arki 0.3.0 adds a manual GitHub version check and portable release packaging. Update metadata does not include project content; checks do not install or restart software. See [release notes](releases/v0.3.0.md). These distribution features do not change the task-binding or model-accuracy limits above.",
  );

  const output = `${lines.join("\n")}\n`;
  assertSanitizedProbeOutput(output);
  return output;
}

export function parseCliArguments(args: readonly string[]): CliArguments {
  let format: CliArguments["format"] = "json";
  let preflight = true;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--skip-executable-preflight") {
      preflight = false;
      continue;
    }
    if (argument === "--format") {
      const value = args[index + 1];
      if (value !== "json" && value !== "markdown") {
        throw new Error("Only json and markdown output formats are supported");
      }
      format = value;
      index += 1;
      continue;
    }
    throw new Error("This probe does not accept task identifiers or workspace paths");
  }
  return { format, preflight };
}

export async function createStandaloneProbeOutput(args: readonly string[]): Promise<string> {
  const options = parseCliArguments(args);
  const manifest = await readFile(VERSION_MANIFEST_URL, "utf8");
  const facts = parseGeneratedVersionManifest(manifest);
  const preflight = options.preflight
    ? runReadOnlyExecutablePreflight({
        executable: facts.schemaCliBasename,
        source: "direct_executable_lookup",
        expectedDesktopVersion: facts.desktopVersion,
      })
    : undefined;
  const report = buildCurrentCapabilityReport(facts, preflight);
  return options.format === "markdown"
    ? renderCapabilityReportMarkdown(report)
    : renderCapabilityReportJson(report);
}

function isMainModule(): boolean {
  const argument = process.argv[1];
  if (!argument) return false;
  const modulePath = resolve(fileURLToPath(import.meta.url));
  const argumentPath = resolve(argument);
  return process.platform === "win32"
    ? modulePath.toLowerCase() === argumentPath.toLowerCase()
    : modulePath === argumentPath;
}

if (isMainModule()) {
  void createStandaloneProbeOutput(process.argv.slice(2))
    .then((output) => process.stdout.write(output))
    .catch(() => {
      process.stderr.write('{"component":"aimd-live-probe","code":"SANITIZED_PROBE_FAILED"}\n');
      process.exitCode = 1;
    });
}
