import { App } from "@modelcontextprotocol/ext-apps";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

import {
  PROBE_SOURCE_URI,
  PROBE_TOOL_NAME,
  parseCapabilityProbeReport,
  type CapabilityProbeReport,
} from "./probe-contract.js";

type ProbeToolResult = {
  readonly isError?: boolean | undefined;
  readonly content: readonly unknown[];
  readonly structuredContent?: unknown | undefined;
};

type ProbeResourceResult = {
  readonly contents: readonly ({
    readonly uri: string;
    readonly text?: string | undefined;
    readonly blob?: string | undefined;
  })[];
};

export type ProbeAppPort = {
  connect(transport?: Transport): Promise<void>;
  requestDisplayMode(params: { readonly mode: "fullscreen" }): Promise<{ readonly mode: string }>;
  callServerTool(params: {
    readonly name: string;
    readonly arguments: {
      readonly challenge: string;
      readonly sourceHash: string;
      readonly fullscreenRequested: true;
    };
  }): Promise<ProbeToolResult>;
  readServerResource(params: { readonly uri: string }): Promise<ProbeResourceResult>;
};

export type BrowserTextHasher = (text: string) => Promise<string>;
export type ProbeRenderer = (report: CapabilityProbeReport) => void;

export async function browserSha256Text(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function exactTextResource(result: ProbeResourceResult, uri: string): string {
  const matching = result.contents.filter((content) => content.uri === uri && typeof content.text === "string");
  if (matching.length !== 1 || matching[0]?.text === undefined) {
    throw new Error("AIMD probe source peek is missing or ambiguous");
  }
  return matching[0].text;
}

/** Runs the same browser path used by the packaged probe and is transport-injectable for P0-A tests. */
export async function runProbeUi(
  app: ProbeAppPort,
  render: ProbeRenderer,
  challenge: string,
  hashText: BrowserTextHasher = browserSha256Text,
  transport?: Transport,
): Promise<CapabilityProbeReport> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._~-]*$/u.test(challenge)) {
    throw new Error("AIMD probe challenge is unavailable");
  }
  if (transport === undefined) await app.connect();
  else await app.connect(transport);

  // Fullscreen is a presentation enhancement, not permission to inspect the
  // capability report. Hosts may keep the App inline; the trusted report and
  // its hash-bound source must still be validated and shown.
  try {
    await app.requestDisplayMode({ mode: "fullscreen" });
  } catch {
    // Some hosts do not implement this presentation-only request. The trusted
    // report and its source verification must remain available inline.
  }

  const source = await app.readServerResource({ uri: PROBE_SOURCE_URI });
  const sourceText = exactTextResource(source, PROBE_SOURCE_URI);
  const actualHash = await hashText(sourceText);

  const result = await app.callServerTool({
    name: PROBE_TOOL_NAME,
    arguments: {
      challenge,
      sourceHash: actualHash,
      fullscreenRequested: true,
    },
  });
  if (result.structuredContent === undefined) {
    throw new Error("AIMD probe did not return a structured capability report");
  }
  const report = parseCapabilityProbeReport(result.structuredContent);
  if (actualHash !== report.sourcePeek.excerptHash) {
    throw new Error("AIMD probe source peek hash mismatch");
  }

  render(report);
  return report;
}

export function renderProbeReport(report: CapabilityProbeReport, target: HTMLElement): void {
  target.replaceChildren();
  const heading = document.createElement("h1");
  heading.textContent = "AIMD Reader capability probe";
  target.append(heading);

  const list = document.createElement("ol");
  for (const gate of report.gates) {
    const row = document.createElement("li");
    row.dataset.status = gate.status;
    row.textContent = `${gate.id} · ${gate.status} · ${gate.summary}`;
    list.append(row);
  }
  target.append(list);
}

export async function bootstrapProbeUi(): Promise<void> {
  const target = document.querySelector<HTMLElement>("[data-aimd-probe-status]");
  if (!target) throw new Error("AIMD probe status target is missing");
  const app = new App(
    { name: "AIMD capability probe", version: "0.1.0" },
    {},
    { strict: true, autoResize: false },
  );
  const challenge = document.documentElement.dataset.aimdProbeChallenge;
  if (!challenge) throw new Error("AIMD probe challenge is unavailable");
  await runProbeUi(app, (report) => renderProbeReport(report, target), challenge);
}

if (
  typeof window !== "undefined" &&
  typeof document !== "undefined" &&
  document.documentElement.dataset.aimdProbeAutoStart === "true"
) {
  void bootstrapProbeUi().catch(() => {
    const target = document.querySelector<HTMLElement>("[data-aimd-probe-status]");
    if (target) target.textContent = "Capability probe failed safely. See the sanitized server report.";
  });
}
