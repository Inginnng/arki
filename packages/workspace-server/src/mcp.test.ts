import { App } from "@modelcontextprotocol/ext-apps";
import { RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { sha256Text } from "@aimd/reader-core";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  PROBE_RESOURCE_URI,
  PROBE_SOURCE_TEXT,
  PROBE_SOURCE_URI,
  READER_RESOURCE_URI,
  CapabilityProbeReportSchema,
  createReaderMcpServer,
  createProbeMcpServer,
  parseCapabilityProbeReport,
  type CapabilityProbeReport,
  type ProbeBindingContext,
  type ProbeUiObservation,
  type RawHostRequestMetadata,
} from "./mcp.js";
import { runProbeUi } from "./probe-ui.js";

const openConnections: Array<{ close(): Promise<void> }> = [];

function toolVisibility(meta: unknown): unknown {
  if (typeof meta !== "object" || meta === null || !("ui" in meta)) return undefined;
  const ui = meta.ui;
  if (typeof ui !== "object" || ui === null || !("visibility" in ui)) return undefined;
  return ui.visibility;
}

afterEach(async () => {
  await Promise.allSettled(openConnections.splice(0).map((connection) => connection.close()));
});

function passedReport(): CapabilityProbeReport {
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
    sourcePeek: {
      uri: PROBE_SOURCE_URI,
      excerptHash: sha256Text(PROBE_SOURCE_TEXT),
    },
  };
}

async function connectMcp(
  runProbe = vi.fn(async (
    _binding: ProbeBindingContext,
    _observation: ProbeUiObservation,
  ) => passedReport()),
  captureHostContext = vi.fn((_metadata: RawHostRequestMetadata | undefined): ProbeBindingContext => ({
    status: "unavailable",
  })),
) {
  const server = createProbeMcpServer({
    probeHtml: '<!doctype html><html lang="en" data-aimd-probe-auto-start="true"><title>AIMD probe</title></html>',
    captureHostContext,
    runProbe,
  });
  const client = new Client({ name: "aimd-test-host", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  openConnections.push(client, server);
  return { client, runProbe, captureHostContext };
}

async function readProbeChallenge(client: Client): Promise<string> {
  const resource = await client.readResource({ uri: PROBE_RESOURCE_URI });
  const text = resource.contents[0] && "text" in resource.contents[0]
    ? resource.contents[0].text
    : undefined;
  const challenge = typeof text === "string"
    ? /data-aimd-probe-challenge="([A-Za-z0-9_-]+)"/u.exec(text)?.[1]
    : undefined;
  if (!challenge) throw new Error("probe resource did not contain a challenge");
  return challenge;
}

describe("Phase 0 MCP Apps surface", () => {
  it("rejects a bare protocol probe call before metadata capture or live execution", async () => {
    const { client, runProbe, captureHostContext } = await connectMcp();

    const result = await client.callTool({
      name: "aimd_run_capability_probe",
      arguments: {},
    });

    expect(result.isError).toBe(true);
    expect(runProbe).not.toHaveBeenCalled();
    expect(captureHostContext).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain('\"status\":\"passed\"');
  });

  it("atomically consumes the resource-bound challenge before live execution", async () => {
    const { client, runProbe } = await connectMcp();
    const challenge = await readProbeChallenge(client);
    const arguments_ = {
      challenge,
      sourceHash: sha256Text(PROBE_SOURCE_TEXT),
      fullscreenRequested: true as const,
    };

    const first = await client.callTool({
      name: "aimd_run_capability_probe",
      arguments: arguments_,
    });
    const replay = await client.callTool({
      name: "aimd_run_capability_probe",
      arguments: arguments_,
    });

    expect(first.isError).not.toBe(true);
    expect(runProbe).toHaveBeenCalledTimes(1);
    expect(runProbe.mock.calls[0]?.[1]).toEqual({ resourceChallengeCompleted: true });
    expect(replay.isError).toBe(true);
    expect(JSON.stringify(replay)).not.toContain(challenge);
    expect(JSON.stringify(replay)).not.toContain('\"status\":\"passed\"');
  });

  it("consumes a challenge on wrong source hash and does not cross the capture boundary", async () => {
    const { client, runProbe, captureHostContext } = await connectMcp();
    const challenge = await readProbeChallenge(client);
    const call = (sourceHash: string) => client.callTool({
      name: "aimd_run_capability_probe",
      arguments: { challenge, sourceHash, fullscreenRequested: true },
    });

    const wrong = await call("0".repeat(64));
    const retry = await call(sha256Text(PROBE_SOURCE_TEXT));

    expect(wrong.isError).toBe(true);
    expect(retry.isError).toBe(true);
    expect(runProbe).not.toHaveBeenCalled();
    expect(captureHostContext).not.toHaveBeenCalled();
    expect(JSON.stringify([wrong, retry])).not.toContain(challenge);
    expect(JSON.stringify([wrong, retry])).not.toContain('\"status\":\"passed\"');
  });

  it("allows only one concurrent caller to consume a challenge", async () => {
    const { client, runProbe } = await connectMcp();
    const challenge = await readProbeChallenge(client);
    const call = () => client.callTool({
      name: "aimd_run_capability_probe",
      arguments: {
        challenge,
        sourceHash: sha256Text(PROBE_SOURCE_TEXT),
        fullscreenRequested: true,
      },
    });

    const results = await Promise.all([call(), call()]);

    expect(results.filter((result) => result.isError !== true)).toHaveLength(1);
    expect(results.filter((result) => result.isError === true)).toHaveLength(1);
    expect(runProbe).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(results)).not.toContain(challenge);
  });

  it("expires an unconsumed challenge after a short lifetime", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-09-02T00:00:00Z"));
      const { client, runProbe } = await connectMcp();
      const challenge = await readProbeChallenge(client);
      vi.advanceTimersByTime(30_001);

      const result = await client.callTool({
        name: "aimd_run_capability_probe",
        arguments: {
          challenge,
          sourceHash: sha256Text(PROBE_SOURCE_TEXT),
          fullscreenRequested: true,
        },
      });

      expect(result.isError).toBe(true);
      expect(runProbe).not.toHaveBeenCalled();
      expect(JSON.stringify(result)).not.toContain(challenge);
    } finally {
      vi.useRealTimers();
    }
  });

  it("evicts the oldest resource challenge when the bounded pending set is full", async () => {
    const { client, runProbe } = await connectMcp();
    const challenges: string[] = [];
    for (let index = 0; index < 33; index += 1) {
      challenges.push(await readProbeChallenge(client));
    }

    const result = await client.callTool({
      name: "aimd_run_capability_probe",
      arguments: {
        challenge: challenges[0],
        sourceHash: sha256Text(PROBE_SOURCE_TEXT),
        fullscreenRequested: true,
      },
    });

    expect(result.isError).toBe(true);
    expect(runProbe).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(challenges[0]);
  });

  it("links the render tool to a self-contained resource with the exact Apps MIME", async () => {
    const { client } = await connectMcp();

    const tools = await client.listTools();
    const openTool = tools.tools.find((tool) => tool.name === "aimd_open_capability_probe");
    expect(RESOURCE_MIME_TYPE).toBe("text/html;profile=mcp-app");
    expect(openTool?._meta).toMatchObject({
      ui: {
        resourceUri: PROBE_RESOURCE_URI,
      },
    });
    expect(toolVisibility(openTool?._meta)).toEqual(["model", "app"]);

    const appOnlyTools = tools.tools
      .filter((tool) => JSON.stringify(toolVisibility(tool._meta)) === JSON.stringify(["app"]))
      .map((tool) => tool.name);
    expect(appOnlyTools).toEqual(["aimd_run_capability_probe"]);

    const resource = await client.readResource({ uri: PROBE_RESOURCE_URI });
    const item = resource.contents[0];
    expect(item).toEqual(expect.objectContaining({
      uri: PROBE_RESOURCE_URI,
      mimeType: RESOURCE_MIME_TYPE,
    }));
    const resourceText = item && "text" in item ? item.text : undefined;
    expect(resourceText).toContain('data-aimd-probe-auto-start="true"');
    expect(resourceText).toMatch(/data-aimd-probe-challenge="[A-Za-z0-9_-]+"/u);
    expect(resource.contents[0]?._meta).toMatchObject({
      ui: {
        csp: {
          connectDomains: [],
          resourceDomains: [],
          frameDomains: [],
        },
      },
    });
  });

  it("marks the probe runner app-only and passes raw request metadata only to the binding boundary", async () => {
    const captureHostContext = vi.fn((_metadata: RawHostRequestMetadata | undefined): ProbeBindingContext => ({
      status: "candidate",
      bindingToken: "binding-probe-1",
    }));
    const { client, runProbe } = await connectMcp(undefined, captureHostContext);
    const tools = await client.listTools();
    const probeTool = tools.tools.find((tool) => tool.name === "aimd_run_capability_probe");
    expect(probeTool?._meta).toMatchObject({
      ui: {
        resourceUri: PROBE_RESOURCE_URI,
      },
    });
    expect(toolVisibility(probeTool?._meta)).toEqual(["app"]);
    expect(probeTool?.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    });

    const secretTaskId = "thr_this_must_not_leave_the_binding_adapter";
    const challenge = await readProbeChallenge(client);
    const result = await client.callTool({
      name: "aimd_run_capability_probe",
      arguments: {
        challenge,
        sourceHash: sha256Text(PROBE_SOURCE_TEXT),
        fullscreenRequested: true,
      },
      _meta: {
        "openai/threadId": secretTaskId,
        "openai/session": "anonymous-session-must-not-bind",
      },
    });

    expect(runProbe).toHaveBeenCalledTimes(1);
    expect(captureHostContext).toHaveBeenCalledTimes(1);
    expect(captureHostContext.mock.calls[0]?.[0]).toMatchObject({
      "openai/threadId": secretTaskId,
      "openai/session": "anonymous-session-must-not-bind",
    });
    expect(runProbe.mock.calls[0]?.[0]).toEqual({
      status: "candidate",
      bindingToken: "binding-probe-1",
    });
    expect(runProbe.mock.calls[0]?.[1]).toEqual({ resourceChallengeCompleted: true });
    expect(JSON.stringify(runProbe.mock.calls[0]?.[0])).not.toContain(secretTaskId);
    expect(JSON.stringify(result)).not.toContain(secretTaskId);
    expect(result.structuredContent).toEqual(passedReport());
  });

  it("serves a source peek whose exact text still matches its advertised hash", async () => {
    const { client } = await connectMcp();
    const resource = await client.readResource({ uri: PROBE_SOURCE_URI });
    const item = resource.contents[0];
    expect(item && "text" in item ? item.text : undefined).toBe(PROBE_SOURCE_TEXT);
    expect(sha256Text(PROBE_SOURCE_TEXT)).toBe(passedReport().sourcePeek.excerptHash);
  });

  it("sanitizes thrown probe errors without returning hidden ids, paths, or excerpts", async () => {
    const secret = "thr_secret D:\\Users\\secret\\project private excerpt";
    const { client } = await connectMcp(vi.fn(async () => {
      throw new Error(secret);
    }));
    const challenge = await readProbeChallenge(client);

    const result = await client.callTool({
      name: "aimd_run_capability_probe",
      arguments: {
        challenge,
        sourceHash: sha256Text(PROBE_SOURCE_TEXT),
        fullscreenRequested: true,
      },
      _meta: { "openai/threadId": "thr_secret" },
    });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain("thr_secret");
    expect(JSON.stringify(result)).not.toContain("private excerpt");
    expect(result.structuredContent).toMatchObject({
      featureFlags: { task_and_project: false, project_only: false, reader_only: false },
    });
    expect((result.structuredContent as CapabilityProbeReport).gates[0]).toMatchObject({
      diagnosticCode: "PROBE_INTERNAL_FAILURE",
    });
  });
});

describe("capability report trust boundary", () => {
  it.each([
    {
      name: "project mode",
      statuses: ["passed", "not_run", "not_run", "passed", "passed"],
      flags: { task_and_project: false, project_only: true, reader_only: false },
    },
    {
      name: "task and project mode",
      statuses: ["passed", "passed", "passed", "passed", "passed"],
      flags: { task_and_project: true, project_only: true, reader_only: false },
    },
    {
      name: "reader-only mode",
      statuses: ["passed", "not_run", "not_run", "not_run", "passed"],
      flags: { task_and_project: false, project_only: false, reader_only: true },
    },
    {
      name: "unavailable mode",
      statuses: ["failed", "not_run", "not_run", "not_run", "passed"],
      flags: { task_and_project: false, project_only: false, reader_only: false },
    },
  ] as const)("accepts feature flags strictly derived for $name", ({ statuses, flags }) => {
    const candidate = passedReport();
    candidate.gates = candidate.gates.map((gate, index) => ({
      ...gate,
      status: statuses[index]!,
    }));
    candidate.featureFlags = flags;

    expect(parseCapabilityProbeReport(candidate).featureFlags).toEqual(flags);
  });

  it.each([
    {
      name: "task context claimed without B through D passing",
      mutate: (candidate: CapabilityProbeReport) => {
        candidate.featureFlags.task_and_project = true;
      },
    },
    {
      name: "project context withheld despite A, D, and E passing",
      mutate: (candidate: CapabilityProbeReport) => {
        candidate.gates[3] = { ...candidate.gates[3]!, status: "passed" };
        candidate.featureFlags = { task_and_project: false, project_only: false, reader_only: true };
      },
    },
    {
      name: "context claimed after an operational gate fails",
      mutate: (candidate: CapabilityProbeReport) => {
        candidate.gates[0] = {
          id: "P0-A",
          status: "failed",
          summary: "The capability probe failed at its trusted server boundary.",
        };
      },
    },
  ])("rejects feature flags not derived from gates: $name", ({ mutate }) => {
    const candidate = passedReport();
    mutate(candidate);
    expect(CapabilityProbeReportSchema.safeParse(candidate).success).toBe(false);
  });

  it.each([
    "Bound to thr_secret.",
    "Latest turn_123 was accepted.",
    "Metadata key openai/threadId was present.",
    "Read D:\\Users\\alice\\repo\\README.md.",
    "Read \\\\server\\share\\repo\\README.md.",
    "Read /home/alice/repo/README.md.",
    "line one\nline two",
    "Task 550e8400-e29b-41d4-a716-446655440000 was verified.",
    "The implementation contains private excerpt secret_falcon_value.",
  ])("rejects an unsanitized gate summary: %s", (summary) => {
    const base = passedReport();
    const candidate = {
      ...base,
      gates: base.gates.map((gate, index) => (
        index === 1 ? { id: "P0-B", status: "not_run", summary } : gate
      )),
    };
    expect(CapabilityProbeReportSchema.safeParse(candidate).success).toBe(false);
  });

  it("accepts a concise summary without hidden identifiers or absolute paths", () => {
    const candidate = passedReport();
    candidate.gates[1] = {
      id: "P0-B",
      status: "not_run",
      summary: "Exact task binding was not evaluated.",
    };
    expect(CapabilityProbeReportSchema.safeParse(candidate).success).toBe(true);
  });

  it("rejects caller-authored diagnostic codes even when they match the old shape", () => {
    const base = passedReport();
    const candidate: unknown = {
      ...base,
      gates: base.gates.map((gate, index) => index === 0
        ? { ...gate, diagnosticCode: "SECRET_FALCON_VALUE" }
        : gate),
    };
    expect(CapabilityProbeReportSchema.safeParse(candidate).success).toBe(false);
  });
});

describe("in-memory MCP Apps UI loop", () => {
  it("connects, requests fullscreen, calls only the app probe, and verifies the source peek", async () => {
    const { client } = await connectMcp();
    const challenge = await readProbeChallenge(client);
    const [appTransport, hostTransport] = InMemoryTransport.createLinkedPair();
    const observedMethods: string[] = [];

    hostTransport.onmessage = async (message) => {
      if (!("method" in message)) return;
      observedMethods.push(message.method);
      if (!("id" in message)) return;

      let result: Record<string, unknown>;
      if (message.method === "ui/initialize") {
        result = {
          protocolVersion: "2025-11-21",
          hostInfo: { name: "AIMD in-memory host", version: "1.0.0" },
          hostCapabilities: {},
          hostContext: {
            displayMode: "inline",
            availableDisplayModes: ["inline", "fullscreen"],
          },
        };
      } else if (message.method === "ui/request-display-mode") {
        result = { mode: "fullscreen" };
      } else if (message.method === "tools/call") {
        const params = message.params as { name: string; arguments?: Record<string, unknown> };
        result = await client.callTool({
          ...params,
          _meta: { "openai/threadId": "thr_in_memory_only" },
        }) as Record<string, unknown>;
      } else if (message.method === "resources/read") {
        result = await client.readResource(message.params as { uri: string }) as Record<string, unknown>;
      } else {
        throw new Error(`Unexpected UI request: ${message.method}`);
      }

      await hostTransport.send({ jsonrpc: "2.0", id: message.id, result });
    };
    await hostTransport.start();
    openConnections.push(hostTransport);

    const app = new App(
      { name: "AIMD capability probe", version: "0.1.0" },
      {},
      { autoResize: false, strict: true },
    );
    const rendered: CapabilityProbeReport[] = [];
    const result = await runProbeUi(
      app,
      (report) => rendered.push(report),
      challenge,
      async (text) => sha256Text(text),
      appTransport,
    );
    expect(result).toEqual(passedReport());
    expect(rendered).toEqual([passedReport()]);
    expect(observedMethods).toContain("ui/request-display-mode");
    expect(observedMethods).toContain("tools/call");
    expect(observedMethods).toContain("resources/read");
    expect(observedMethods).not.toContain("ui/message");
    expect(observedMethods.filter((method) => method === "tools/call")).toHaveLength(1);
  });
});

describe("reader MCP Apps surface", () => {
  it("registers the fullscreen reader resource and only one model-visible reader tool", async () => {
    const service = {
      listRoots: vi.fn(async () => []),
      listDocuments: vi.fn(async () => []),
      openDocument: vi.fn(async () => ({})),
      readSource: vi.fn(async () => ({})),
      captureSessionBinding: vi.fn(() => ({ status: "unavailable" })),
      createSessionFromBinding: vi.fn(async () => ({})),
      authorizeAccess: vi.fn(async () => undefined),
      startQuestion: vi.fn(async () => ({})),
      pollQuestion: vi.fn(async () => ({})),
      cancelQuestion: vi.fn(async () => undefined),
      setDisposition: vi.fn(async () => undefined),
      preparePatch: vi.fn(async () => ({})),
      approvePatch: vi.fn(async () => ({})),
      writeExplained: vi.fn(async () => ({})),
    };
    const server = createReaderMcpServer({
      readerHtml: "<!doctype html><html><title>AIMD Reader</title></html>",
      probeHtml: '<!doctype html><html lang="en"><title>AIMD probe</title></html>',
      service,
      captureHostContext: () => ({ status: "unavailable" }),
      runProbe: async () => passedReport(),
    });
    const client = new Client({ name: "aimd-reader-test-host", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    openConnections.push(client, server);

    const tools = await client.listTools();
    const readerToolNames = tools.tools
      .map((tool) => tool.name)
      .filter((name) => name.startsWith("aimd_") && !name.includes("capability_probe"))
      .sort();
    expect(readerToolNames).toEqual([
      "aimd_approve_patch",
      "aimd_ask_start",
      "aimd_cancel_question",
      "aimd_create_session",
      "aimd_list_documents",
      "aimd_list_roots",
      "aimd_open_reader",
      "aimd_prepare_patch",
      "aimd_question_events",
      "aimd_read_document",
      "aimd_read_source",
      "aimd_set_disposition",
      "aimd_write_explained",
    ]);
    const openTool = tools.tools.find((tool) => tool.name === "aimd_open_reader");
    expect(openTool?._meta).toMatchObject({
      ui: { resourceUri: READER_RESOURCE_URI, visibility: ["model", "app"] },
    });
    const internalTools = tools.tools.filter((tool) =>
      readerToolNames.includes(tool.name) && tool.name !== "aimd_open_reader"
    );
    expect(internalTools.every((tool) =>
      JSON.stringify(toolVisibility(tool._meta)) === JSON.stringify(["app"])
    )).toBe(true);
    for (const toolName of ["aimd_create_session", "aimd_ask_start", "aimd_cancel_question"]) {
      expect(tools.tools.find((tool) => tool.name === toolName)?.annotations?.readOnlyHint).toBe(false);
    }

    const resource = await client.readResource({ uri: READER_RESOURCE_URI });
    expect(resource.contents[0]).toMatchObject({
      uri: READER_RESOURCE_URI,
      mimeType: RESOURCE_MIME_TYPE,
    });
    const html = resource.contents[0] && "text" in resource.contents[0]
      ? resource.contents[0].text
      : undefined;
    expect(html).toContain("AIMD Reader");
    expect(resource.contents[0]?._meta).toMatchObject({
      ui: {
        csp: { connectDomains: [], resourceDomains: [], frameDomains: [] },
      },
    });
  });

  it("negotiates MCP roots for every root-scoped tool and captures metadata only for session binding", async () => {
    const service = {
      listRoots: vi.fn(async (roots?: readonly { uri: string }[]) =>
        roots?.some((root) => root.uri === "file:///D:/fixture")
          ? [{ rootId: "root-1", workspaceLabel: "fixture" }]
          : []),
      listDocuments: vi.fn(async () => []),
      openDocument: vi.fn(async () => ({})),
      readSource: vi.fn(async () => ({})),
      captureSessionBinding: vi.fn(() => ({ status: "candidate", token: "binding-1" })),
      createSessionFromBinding: vi.fn(async () => ({ id: "session-1" })),
      authorizeAccess: vi.fn(async () => undefined),
      startQuestion: vi.fn(async () => ({})),
      pollQuestion: vi.fn(async () => ({})),
      cancelQuestion: vi.fn(async () => undefined),
      setDisposition: vi.fn(async () => undefined),
      preparePatch: vi.fn(async () => ({})),
      approvePatch: vi.fn(async () => ({})),
      writeExplained: vi.fn(async () => ({})),
    };
    const server = createReaderMcpServer({
      readerHtml: "<!doctype html><html><title>AIMD Reader</title></html>",
      probeHtml: '<!doctype html><html lang="en"><title>AIMD probe</title></html>',
      service,
      captureHostContext: () => ({ status: "unavailable" }),
      runProbe: async () => passedReport(),
    });
    const client = new Client(
      { name: "aimd-root-test-host", version: "1.0.0" },
      { capabilities: { roots: { listChanged: true } } },
    );
    const listRoots = vi.fn(async () => ({
      roots: [{ uri: "file:///D:/fixture", name: "fixture" }],
    }));
    client.setRequestHandler(ListRootsRequestSchema, listRoots);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    openConnections.push(client, server);

    const roots = await client.callTool({ name: "aimd_list_roots", arguments: {} });
    expect(roots.structuredContent).toEqual({
      roots: [{ rootId: "root-1", workspaceLabel: "fixture" }],
    });
    expect(listRoots).toHaveBeenCalledTimes(1);
    expect(service.listRoots).toHaveBeenLastCalledWith([{ uri: "file:///D:/fixture" }]);

    const denied = await client.callTool({
      name: "aimd_list_documents",
      arguments: { rootId: "root-2" },
      _meta: { "openai/threadId": "thr_must_be_ignored" },
    });
    expect(denied.isError).toBe(true);
    expect(denied.structuredContent).toEqual({
      status: "error",
      code: "MCP_ROOT_NOT_AUTHORIZED",
    });
    expect(service.listDocuments).not.toHaveBeenCalled();

    const allowed = await client.callTool({
      name: "aimd_list_documents",
      arguments: { rootId: "root-1" },
      _meta: { "openai/threadId": "thr_must_be_ignored" },
    });
    expect(allowed.isError).not.toBe(true);
    expect(service.listDocuments).toHaveBeenCalledWith("root-1");

    const session = await client.callTool({
      name: "aimd_create_session",
      arguments: { rootId: "root-1", path: "README.md" },
      _meta: { "openai/threadId": "thr_binding_candidate" },
    });
    expect(session.isError).not.toBe(true);
    expect(service.captureSessionBinding).toHaveBeenCalledWith(
      expect.objectContaining({ "openai/threadId": "thr_binding_candidate" }),
    );
    expect(service.createSessionFromBinding).toHaveBeenCalledWith(
      "root-1",
      "README.md",
      { status: "candidate", token: "binding-1" },
    );
    expect(service.captureSessionBinding.mock.invocationCallOrder[0]).toBeLessThan(
      service.listRoots.mock.invocationCallOrder.at(-1)!,
    );

    const ask = await client.callTool({
      name: "aimd_ask_start",
      arguments: {
        sessionId: "session-1",
        question: { question: "How does work enter?", startOffset: 9, endOffset: 26 },
      },
    });
    expect(ask.isError).not.toBe(true);
    expect(service.startQuestion).toHaveBeenCalledWith(
      "session-1",
      { question: "How does work enter?", startOffset: 9, endOffset: 26 },
    );
    expect(service.authorizeAccess).toHaveBeenCalledWith(
      { kind: "session", id: "session-1" },
      [{ uri: "file:///D:/fixture" }],
    );

    const hiddenMeta = { "openai/threadId": "thr_must_be_ignored_everywhere" };
    await client.callTool({
      name: "aimd_read_document",
      arguments: { rootId: "root-1", path: "README.md" },
      _meta: hiddenMeta,
    });
    await client.callTool({
      name: "aimd_read_source",
      arguments: { rootId: "root-1", path: "README.md", startLine: 1, endLine: 1 },
      _meta: hiddenMeta,
    });
    await client.callTool({ name: "aimd_question_events", arguments: { runId: "run-1" }, _meta: hiddenMeta });
    await client.callTool({ name: "aimd_cancel_question", arguments: { runId: "run-1" }, _meta: hiddenMeta });
    await client.callTool({
      name: "aimd_set_disposition",
      arguments: { annotationId: "annotation-1", disposition: "inline" },
      _meta: hiddenMeta,
    });
    await client.callTool({
      name: "aimd_prepare_patch",
      arguments: { sessionId: "session-1", annotationIds: ["annotation-1"] },
      _meta: hiddenMeta,
    });
    await client.callTool({
      name: "aimd_approve_patch",
      arguments: { sessionId: "session-1", sourceHash: "a".repeat(64), diffHash: "b".repeat(64) },
      _meta: hiddenMeta,
    });
    await client.callTool({
      name: "aimd_write_explained",
      arguments: { sessionId: "session-1", previewId: "preview-1", approvalToken: "A".repeat(43) },
      _meta: hiddenMeta,
    });

    expect(service.captureSessionBinding).toHaveBeenCalledTimes(1);
    expect(service.authorizeAccess).toHaveBeenCalledWith(
      { kind: "run", id: "run-1" },
      [{ uri: "file:///D:/fixture" }],
    );
    expect(service.authorizeAccess).toHaveBeenCalledWith(
      { kind: "annotation", id: "annotation-1" },
      [{ uri: "file:///D:/fixture" }],
    );
    expect(service.authorizeAccess).toHaveBeenCalledWith(
      { kind: "preview", id: "preview-1" },
      [{ uri: "file:///D:/fixture" }],
    );
    expect(JSON.stringify(allowed)).not.toContain("thr_must_be_ignored");
  });

  it("fails closed when a previously-bound session loses MCP root authorization", async () => {
    const revoked = Object.assign(new Error("private revoked root"), {
      code: "ROOT_AUTHORIZATION_REVOKED",
    });
    const service = {
      listRoots: vi.fn(async () => [{ rootId: "root-1", workspaceLabel: "fixture" }]),
      listDocuments: vi.fn(async () => []),
      openDocument: vi.fn(async () => ({})),
      readSource: vi.fn(async () => ({})),
      captureSessionBinding: vi.fn(() => ({ status: "unavailable" })),
      createSessionFromBinding: vi.fn(async () => ({ id: "session-1" })),
      authorizeAccess: vi.fn(async () => { throw revoked; }),
      startQuestion: vi.fn(async () => ({})),
      pollQuestion: vi.fn(async () => ({})),
      cancelQuestion: vi.fn(async () => undefined),
      setDisposition: vi.fn(async () => undefined),
      preparePatch: vi.fn(async () => ({})),
      approvePatch: vi.fn(async () => ({})),
      writeExplained: vi.fn(async () => ({})),
    };
    const server = createReaderMcpServer({
      readerHtml: "<!doctype html><html><title>AIMD Reader</title></html>",
      probeHtml: '<!doctype html><html lang="en"><title>AIMD probe</title></html>',
      service,
      captureHostContext: () => ({ status: "unavailable" }),
      runProbe: async () => passedReport(),
    });
    const client = new Client(
      { name: "aimd-revoked-root-host", version: "1.0.0" },
      { capabilities: { roots: { listChanged: true } } },
    );
    client.setRequestHandler(ListRootsRequestSchema, async () => ({
      roots: [{ uri: "file:///D:/fixture", name: "fixture" }],
    }));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    openConnections.push(client, server);

    const result = await client.callTool({
      name: "aimd_ask_start",
      arguments: {
        sessionId: "session-1",
        question: { question: "What changed?", startOffset: 0, endOffset: 4 },
      },
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      status: "error",
      code: "ROOT_AUTHORIZATION_REVOKED",
    });
    expect(service.startQuestion).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("private revoked root");
  });

  it("sanitizes reader failures without invoking accessor-shaped error fields", async () => {
    let reads = 0;
    const thrown = Object.defineProperty(new Error("thr_secret private excerpt"), "code", {
      enumerable: true,
      get() {
        reads += 1;
        return "SECRET_CODE";
      },
    });
    const service = {
      listRoots: vi.fn(async () => { throw thrown; }),
      listDocuments: vi.fn(async () => []),
      openDocument: vi.fn(async () => ({})),
      readSource: vi.fn(async () => ({})),
      captureSessionBinding: vi.fn(() => ({ status: "unavailable" })),
      createSessionFromBinding: vi.fn(async () => ({})),
      authorizeAccess: vi.fn(async () => undefined),
      startQuestion: vi.fn(async () => ({})),
      pollQuestion: vi.fn(async () => ({})),
      cancelQuestion: vi.fn(async () => undefined),
      setDisposition: vi.fn(async () => undefined),
      preparePatch: vi.fn(async () => ({})),
      approvePatch: vi.fn(async () => ({})),
      writeExplained: vi.fn(async () => ({})),
    };
    const server = createReaderMcpServer({
      readerHtml: "<!doctype html><html><title>AIMD Reader</title></html>",
      probeHtml: '<!doctype html><html lang="en"><title>AIMD probe</title></html>',
      service,
      captureHostContext: () => ({ status: "unavailable" }),
      runProbe: async () => passedReport(),
    });
    const client = new Client({ name: "aimd-reader-error-host", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    openConnections.push(client, server);

    const result = await client.callTool({ name: "aimd_list_roots", arguments: {} });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      status: "error",
      code: "READER_OPERATION_FAILED",
    });
    expect(reads).toBe(0);
    expect(JSON.stringify(result)).not.toContain("thr_secret");
    expect(JSON.stringify(result)).not.toContain("private excerpt");
  });

  it("passes through only finite service error codes", async () => {
    const unknown = Object.assign(new Error("private failure"), { code: "SECRET_CODE" });
    const known = Object.assign(new Error("hidden source changed details"), { code: "SOURCE_CHANGED" });
    const listRoots = vi
      .fn<() => Promise<unknown>>()
      .mockRejectedValueOnce(unknown)
      .mockRejectedValueOnce(known);
    const service = {
      listRoots,
      listDocuments: vi.fn(async () => []),
      openDocument: vi.fn(async () => ({})),
      readSource: vi.fn(async () => ({})),
      captureSessionBinding: vi.fn(() => ({ status: "unavailable" })),
      createSessionFromBinding: vi.fn(async () => ({})),
      authorizeAccess: vi.fn(async () => undefined),
      startQuestion: vi.fn(async () => ({})),
      pollQuestion: vi.fn(async () => ({})),
      cancelQuestion: vi.fn(async () => undefined),
      setDisposition: vi.fn(async () => undefined),
      preparePatch: vi.fn(async () => ({})),
      approvePatch: vi.fn(async () => ({})),
      writeExplained: vi.fn(async () => ({})),
    };
    const server = createReaderMcpServer({
      readerHtml: "<!doctype html><html><title>AIMD Reader</title></html>",
      probeHtml: '<!doctype html><html lang="en"><title>AIMD probe</title></html>',
      service,
      captureHostContext: () => ({ status: "unavailable" }),
      runProbe: async () => passedReport(),
    });
    const client = new Client({ name: "aimd-reader-code-host", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    openConnections.push(client, server);

    const first = await client.callTool({ name: "aimd_list_roots", arguments: {} });
    expect(first.structuredContent).toEqual({ status: "error", code: "READER_OPERATION_FAILED" });
    const second = await client.callTool({ name: "aimd_list_roots", arguments: {} });
    expect(second.structuredContent).toEqual({ status: "error", code: "SOURCE_CHANGED" });
    expect(JSON.stringify([first, second])).not.toContain("private failure");
    expect(JSON.stringify([first, second])).not.toContain("hidden source changed details");
  });
});
