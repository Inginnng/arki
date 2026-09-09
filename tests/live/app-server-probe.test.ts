import { readFile } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import {
  assertSanitizedProbeOutput,
  buildCurrentCapabilityReport,
  parseCliArguments,
  parseGeneratedVersionManifest,
  renderCapabilityReportJson,
  renderCapabilityReportMarkdown,
  runReadOnlyExecutablePreflight,
} from "./app-server-probe.js";

const VERSION_MANIFEST = `# Codex App Server generated protocol

- Schema CLI: \`codex.exe\` (path redacted)
- Schema CLI version: \`0.151.0-alpha.7.2\`
- Schema command: \`codex app-server generate-ts --out <generated> --experimental\`
- Generated at: \`2026-09-01T19:54:40.707Z\`
- Desktop/host version: \`0.151.0-alpha.7.2\`
- Desktop/host compatibility: \`matched\`
- PATH CLI version: \`0.152.0\`
- PATH CLI compatibility: \`mismatch\`
`;

describe("standalone App Server capability report", () => {
  it("parses only the path-redacted generated-version facts", () => {
    expect(parseGeneratedVersionManifest(VERSION_MANIFEST)).toEqual({
      schemaCliBasename: "codex.exe",
      schemaCliVersion: "0.151.0-alpha.7.2",
      desktopVersion: "0.151.0-alpha.7.2",
      desktopCompatibility: "matched",
      pathCliVersion: "0.152.0",
      pathCompatibility: "mismatch",
    });

    expect(() => parseGeneratedVersionManifest(
      VERSION_MANIFEST.replace("`codex.exe` (path redacted)", "`C:\\Private\\codex.exe`"),
    )).toThrow("Generated version manifest is malformed or not path-redacted");
    expect(() => parseGeneratedVersionManifest(
      VERSION_MANIFEST.replace(
        "Desktop/host compatibility: `matched`",
        "Desktop/host compatibility: `mismatch`",
      ),
    )).toThrow("Generated version manifest contains inconsistent compatibility facts");
  });

  it("records local Task 10 verification separately from unavailable live host context", () => {
    const report = buildCurrentCapabilityReport(parseGeneratedVersionManifest(VERSION_MANIFEST));

    expect(report.gates).toEqual([
      expect.objectContaining({ id: "P0-A", status: "inconclusive" }),
      expect.objectContaining({ id: "P0-B", status: "unsupported" }),
      expect.objectContaining({ id: "P0-C", status: "unsupported" }),
      expect.objectContaining({ id: "P0-D", status: "unsupported" }),
      expect.objectContaining({ id: "P0-E", status: "passed" }),
    ]);
    expect(report.featureFlags).toEqual({
      task_and_project: false,
      project_only: false,
      reader_only: false,
    });
    expect(report.safetyBoundary).toEqual({
      rawHostMetadataObserved: false,
      publicTaskIdentifierAccepted: false,
      taskDiscoveryAttempted: false,
      cwdFallbackUsed: false,
      modelTurnStarted: false,
      identifiersPersisted: false,
    });
    expect(report.observation).toBe("task_10_regression");
    expect(report.observedOn).toBe("2026-09-04");
    expect(report.gates[0]?.evidence).toContain("not live desktop attestation");
    expect(report.recoveryChecklist[0]).toContain("Completed:");
  });

  it("preflights only version and App Server help, then redacts the executable path", () => {
    const executable = "C:\\Private\\Codex\\codex.exe";
    const run = vi.fn((receivedExecutable: string, args: readonly string[]) => {
      expect(receivedExecutable).toBe(executable);
      if (args[0] === "--version") {
        return { status: 0, stdout: "codex-cli 0.152.0\n" };
      }
      return { status: 0, stdout: "Usage: codex app-server\nCommands: generate-ts\n" };
    });

    const result = runReadOnlyExecutablePreflight({
      executable,
      source: "verified_host_hint",
      expectedDesktopVersion: "0.151.0-alpha.7.2",
      run,
    });

    expect(run.mock.calls.map((call) => call[1])).toEqual([
      ["--version"],
      ["app-server", "--help"],
    ]);
    expect(result).toEqual({
      source: "verified_host_hint",
      status: "version_mismatch",
      observedVersion: "0.152.0",
      expectedDesktopVersion: "0.151.0-alpha.7.2",
      appServerSurface: "available",
    });
    expect(JSON.stringify(result)).not.toContain(executable);
  });

  it("never upgrades gates based on a standalone executable preflight", () => {
    const facts = parseGeneratedVersionManifest(VERSION_MANIFEST);
    const preflight = runReadOnlyExecutablePreflight({
      executable: "codex.exe",
      source: "verified_host_hint",
      expectedDesktopVersion: facts.desktopVersion,
      run: (_executable, args) => args[0] === "--version"
        ? { status: 0, stdout: `codex-cli ${facts.desktopVersion}\n` }
        : { status: 0, stdout: "Commands: generate-ts\n" },
    });
    const report = buildCurrentCapabilityReport(facts, preflight);

    expect(report.gates.map(({ status }) => status)).toEqual([
      "inconclusive",
      "unsupported",
      "unsupported",
      "unsupported",
      "passed",
    ]);
    expect(report.featureFlags).toEqual({
      task_and_project: false,
      project_only: false,
      reader_only: false,
    });
  });

  it("accepts only parser- and runner-issued builder inputs", () => {
    const facts = parseGeneratedVersionManifest(VERSION_MANIFEST);
    const forgedFacts = { ...facts, schemaCliVersion: "session_host-secret" } as typeof facts;
    expect(() => buildCurrentCapabilityReport(forgedFacts))
      .toThrow("Generated version facts were not issued by the manifest parser");

    expect(() => buildCurrentCapabilityReport(facts, {
      source: "verified_host_hint",
      status: "compatible",
      observedVersion: facts.desktopVersion,
      expectedDesktopVersion: facts.desktopVersion,
      appServerSurface: "available",
    })).toThrow("Executable preflight was not issued by the read-only runner");

    expect(() => runReadOnlyExecutablePreflight({
      executable: "codex.exe",
      source: "session_host-secret" as never,
      expectedDesktopVersion: facts.desktopVersion,
    })).toThrow("Executable preflight options are invalid");
  });

  it("accepts only output-format switches and rejects public task identifiers", () => {
    expect(parseCliArguments([])).toEqual({ format: "json", preflight: true });
    expect(parseCliArguments(["--format", "markdown", "--skip-executable-preflight"]))
      .toEqual({ format: "markdown", preflight: false });
    expect(() => parseCliArguments(["--task-id", "thr_secret-value"]))
      .toThrow("This probe does not accept task identifiers or workspace paths");
    expect(() => parseCliArguments(["--fixture-root", "C:\\Private\\project"]))
      .toThrow("This probe does not accept task identifiers or workspace paths");
  });

  it("renders deterministic sanitized JSON and Markdown without ids or absolute paths", () => {
    const report = buildCurrentCapabilityReport(parseGeneratedVersionManifest(VERSION_MANIFEST));
    const json = renderCapabilityReportJson(report);
    const markdown = renderCapabilityReportMarkdown(report);

    expect(() => assertSanitizedProbeOutput(json)).not.toThrow();
    expect(() => assertSanitizedProbeOutput(markdown)).not.toThrow();
    expect(json).not.toMatch(/(?:thr|turn)_[A-Za-z0-9_-]+/u);
    expect(markdown).not.toMatch(/[A-Za-z]:[\\/]/u);
    expect(markdown).toContain("| P0-A | inconclusive |");
    expect(markdown).toContain("| P0-E | passed |");
    expect(markdown).toContain("reader_only: `false`");
    expect(markdown).toContain("Current result: **degraded**");
    expect(markdown).toContain("cannot enable `reader_only`");
    expect(markdown).toContain("## Initial Phase 0 history");
    expect(markdown).toContain("## Isolated adapter boundary");
    expect(markdown).toContain("enable `aimd-reader@aimd-local`");
  });

  it("fails closed if any renderer input tries to expose a path or host identifier", () => {
    expect(() => assertSanitizedProbeOutput("C:\\Private\\codex.exe"))
      .toThrow("Capability output failed sanitization");
    expect(() => assertSanitizedProbeOutput("/home/private/codex"))
      .toThrow("Capability output failed sanitization");
    expect(() => assertSanitizedProbeOutput("thr_secret-value"))
      .toThrow("Capability output failed sanitization");
    expect(() => assertSanitizedProbeOutput("turn_secret-value"))
      .toThrow("Capability output failed sanitization");
    expect(() => assertSanitizedProbeOutput("item_secret-value"))
      .toThrow("Capability output failed sanitization");
    expect(() => assertSanitizedProbeOutput("session_secret-value"))
      .toThrow("Capability output failed sanitization");
    expect(() => assertSanitizedProbeOutput("openai/turnId /opt/private-vault"))
      .toThrow("Capability output failed sanitization");
  });

  it("renders only immutable reports issued by the fixed-evidence builder", () => {
    const report = buildCurrentCapabilityReport(parseGeneratedVersionManifest(VERSION_MANIFEST));
    const forged = {
      ...report,
      gates: report.gates.map((gate) => gate.id === "P0-E"
        ? { ...gate, evidence: "session_secret copied from /opt/private-vault" }
        : gate),
    } as typeof report;

    expect(Object.isFrozen(report)).toBe(true);
    expect(Object.isFrozen(report.gates)).toBe(true);
    expect(() => renderCapabilityReportJson(forged))
      .toThrow("Capability report was not issued by the standalone builder");
    expect(() => renderCapabilityReportMarkdown(forged))
      .toThrow("Capability report was not issued by the standalone builder");
  });

  it("contains no task discovery, workspace fallback, model, or filesystem-write path", async () => {
    const source = await readFile(new URL("./app-server-probe.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/thread\/list|thread\/read|thread\/fork|turn\/start/u);
    expect(source).not.toContain("process.cwd");
    expect(source).not.toMatch(/writeFile|appendFile|createWriteStream/u);
    expect(source).not.toMatch(/from\s+["']@aimd\/app-server-bridge["']/u);
  });

  it("ships a controlled fixture that requires a deliberate uncommitted sentinel edit", async () => {
    const readme = await readFile(new URL("./fixtures/dirty-project/README.md", import.meta.url), "utf8");
    const source = await readFile(
      new URL("./fixtures/dirty-project/src/architecture.ts", import.meta.url),
      "utf8",
    );

    expect(readme).toContain("AIMD-DIRTY-CONTEXT-LIVE-v1");
    expect(readme).toContain("do not commit");
    expect(source).toContain('LIVE_DIRTY_SENTINEL = "committed-baseline"');
    expect(source).not.toContain("AIMD-DIRTY-CONTEXT-LIVE-v1");
  });

  it("keeps the checked-in capability report aligned with the sanitized renderer", async () => {
    const checkedIn = await readFile(
      new URL("../../docs/capability-report.md", import.meta.url),
      "utf8",
    );
    const facts = parseGeneratedVersionManifest(VERSION_MANIFEST);
    const preflight = runReadOnlyExecutablePreflight({
      executable: "codex.exe",
      source: "direct_executable_lookup",
      expectedDesktopVersion: facts.desktopVersion,
      run: (_executable, args) => args[0] === "--version"
        ? { status: 0, stdout: "codex-cli 0.153.0-alpha.5\n" }
        : { status: 0, stdout: "Commands: generate-ts\n" },
    });
    const expected = renderCapabilityReportMarkdown(buildCurrentCapabilityReport(facts, preflight));

    expect(checkedIn.replace(/\r\n?|\n/gu, "\n")).toBe(expected);
  });
});
