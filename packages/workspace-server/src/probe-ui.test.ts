import { describe, expect, it } from "vitest";

import { PROBE_TOOL_NAME, type CapabilityProbeReport } from "./mcp.js";
import { runProbeUi, type ProbeAppPort } from "./probe-ui.js";

const sourceText = "one trusted probe line\n";
const sourceHash = "6a8261ee8970946cc374e4c2466da4e01782f561a40f9fc6b6bf76e64f4d7fac";
const probeChallenge = "probe-ui-challenge";

function report(): CapabilityProbeReport {
  return {
    reportVersion: 1,
    gates: [
      { id: "P0-A", status: "passed", summary: "The MCP Apps loop completed." },
      { id: "P0-B", status: "not_run", summary: "Live task metadata is required." },
      { id: "P0-C", status: "not_run", summary: "Live task metadata is required." },
      { id: "P0-D", status: "not_run", summary: "Live task metadata is required." },
      { id: "P0-E", status: "passed", summary: "Synthetic failures fail closed." },
    ],
    featureFlags: {
      task_and_project: false,
      project_only: false,
      reader_only: true,
    },
    sourcePeek: { uri: "aimd-evidence://probe/source", excerptHash: sourceHash },
  };
}

describe("probe UI orchestration", () => {
  it("fails closed when the citation source no longer matches", async () => {
    const app: ProbeAppPort = {
      connect: async () => undefined,
      requestDisplayMode: async () => ({ mode: "fullscreen" }),
      callServerTool: async ({ name, arguments: arguments_ }) => {
        expect(name).toBe(PROBE_TOOL_NAME);
        expect(arguments_).toEqual({
          challenge: probeChallenge,
          sourceHash: "0".repeat(64),
          fullscreenRequested: true,
        });
        return { content: [], structuredContent: report() };
      },
      readServerResource: async () => ({
        contents: [{ uri: "aimd-evidence://probe/source", text: "tampered" }],
      }),
    };

    await expect(
      runProbeUi(app, () => undefined, probeChallenge, async () => "0".repeat(64)),
    ).rejects.toThrow("source peek hash mismatch");
  });

  it("rejects missing structured output instead of guessing a status", async () => {
    const app: ProbeAppPort = {
      connect: async () => undefined,
      requestDisplayMode: async () => ({ mode: "fullscreen" }),
      callServerTool: async () => ({ content: [{ type: "text", text: "passed" }] }),
      readServerResource: async ({ uri }) => ({ contents: [{ uri, text: sourceText }] }),
    };

    await expect(
      runProbeUi(app, () => undefined, probeChallenge, async () => sourceHash),
    ).rejects.toThrow("structured capability report");
  });

  it("renders a valid structured failure report even when MCP marks the call as an error", async () => {
    const failed = report();
    failed.gates[0] = {
      id: "P0-A",
      status: "failed",
      summary: "The capability probe failed at its trusted server boundary.",
    };
    failed.featureFlags = { task_and_project: false, project_only: false, reader_only: false };
    const rendered: CapabilityProbeReport[] = [];
    const app: ProbeAppPort = {
      connect: async () => undefined,
      requestDisplayMode: async () => ({ mode: "fullscreen" }),
      callServerTool: async () => ({ isError: true, content: [], structuredContent: failed }),
      readServerResource: async ({ uri }) => ({ contents: [{ uri, text: sourceText }] }),
    };

    await expect(
      runProbeUi(app, (value) => rendered.push(value), probeChallenge, async () => sourceHash),
    ).resolves.toEqual(failed);
    expect(rendered).toEqual([failed]);
  });

  it("hashes the exact source text returned by the server", async () => {
    const seen: string[] = [];
    const app: ProbeAppPort = {
      connect: async () => undefined,
      requestDisplayMode: async () => ({ mode: "fullscreen" }),
      callServerTool: async () => ({ content: [], structuredContent: report() }),
      readServerResource: async ({ uri }) => ({ contents: [{ uri, text: sourceText }] }),
    };

    await runProbeUi(
      app,
      () => undefined,
      probeChallenge,
      async (text) => {
        seen.push(text);
        return sourceHash;
      },
    );
    expect(seen).toEqual([sourceText]);
  });

  it("still probes, verifies the source, and renders when fullscreen is not granted", async () => {
    const events: string[] = [];
    const rendered: CapabilityProbeReport[] = [];
    const app: ProbeAppPort = {
      connect: async () => {
        events.push("connect");
      },
      requestDisplayMode: async () => {
        events.push("display");
        return { mode: "inline" };
      },
      callServerTool: async ({ name, arguments: arguments_ }) => {
        expect(name).toBe(PROBE_TOOL_NAME);
        expect(arguments_).toEqual({
          challenge: "probe-ui-challenge",
          sourceHash,
          fullscreenRequested: true,
        });
        events.push("tool");
        return { content: [], structuredContent: report() };
      },
      readServerResource: async ({ uri }) => {
        events.push("resource");
        return { contents: [{ uri, text: sourceText }] };
      },
    };

    await expect(
      runProbeUi(
        app,
        (value) => {
          events.push("render");
          rendered.push(value);
        },
        probeChallenge,
        async (text) => {
          expect(text).toBe(sourceText);
          events.push("hash");
          return sourceHash;
        },
      ),
    ).resolves.toEqual(report());
    expect(events).toEqual(["connect", "display", "resource", "hash", "tool", "render"]);
    expect(rendered).toEqual([report()]);
  });

  it("still probes and renders when the fullscreen request itself is unsupported", async () => {
    const events: string[] = [];
    const app: ProbeAppPort = {
      connect: async () => { events.push("connect"); },
      requestDisplayMode: async () => {
        events.push("display");
        throw new Error("host path and task id must not escape");
      },
      callServerTool: async () => {
        events.push("tool");
        return { content: [], structuredContent: report() };
      },
      readServerResource: async ({ uri }) => {
        events.push("resource");
        return { contents: [{ uri, text: sourceText }] };
      },
    };

    await expect(runProbeUi(
      app,
      () => { events.push("render"); },
      probeChallenge,
      async () => { events.push("hash"); return sourceHash; },
    )).resolves.toEqual(report());
    expect(events).toEqual(["connect", "display", "resource", "hash", "tool", "render"]);
  });
});
