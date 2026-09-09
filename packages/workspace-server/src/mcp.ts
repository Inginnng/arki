import { randomBytes } from "node:crypto";
import { types as nodeUtilTypes } from "node:util";

import { RESOURCE_MIME_TYPE, registerAppResource, registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { sha256Text } from "@aimd/reader-core";
import {
  DispositionSchema,
  OpaqueIdSchema,
  RelativePathSchema,
  Sha256DigestSchema,
} from "@aimd/contracts";
import { z } from "zod";

import {
  CapabilityProbeReportSchema,
  OPEN_PROBE_TOOL_NAME,
  PROBE_RESOURCE_URI,
  PROBE_SOURCE_TEXT,
  PROBE_SOURCE_URI,
  PROBE_TOOL_NAME,
  parseCapabilityProbeReport,
  type CapabilityProbeReport,
} from "./probe-contract.js";

export {
  CapabilityProbeReportSchema,
  OPEN_PROBE_TOOL_NAME,
  PROBE_RESOURCE_URI,
  PROBE_SOURCE_TEXT,
  PROBE_SOURCE_URI,
  PROBE_TOOL_NAME,
  parseCapabilityProbeReport,
};
export type { CapabilityProbeReport };

export type RawHostRequestMetadata = Readonly<Record<string, unknown>>;

export const READER_RESOURCE_URI = "ui://aimd/reader.html";

export interface ReaderMcpService {
  listRoots(mcpRoots?: readonly { readonly uri: string }[]): Promise<unknown>;
  listDocuments(rootId: string): Promise<unknown>;
  openDocument(rootId: string, path: string): Promise<unknown>;
  readSource(
    rootId: string,
    path: string,
    startLine: number,
    endLine: number,
  ): Promise<unknown>;
  captureSessionBinding(requestMeta: unknown): unknown;
  createSessionFromBinding(rootId: string, path: string, binding: unknown): Promise<unknown>;
  authorizeAccess(
    reference: {
      readonly kind: "session" | "run" | "annotation" | "preview";
      readonly id: string;
    },
    mcpRoots?: readonly { readonly uri: string }[],
  ): Promise<void>;
  startQuestion(sessionId: string, question: unknown): Promise<unknown>;
  pollQuestion(runId: string, cursor?: unknown): Promise<unknown>;
  cancelQuestion(runId: string): Promise<void>;
  setDisposition(annotationId: string, disposition: unknown): Promise<void>;
  preparePatch(sessionId: string, annotationIds: unknown): Promise<unknown>;
  approvePatch(sessionId: string, sourceHash: string, diffHash: string): Promise<unknown>;
  writeExplained(sessionId: string, previewId: string, approvalToken: string): Promise<unknown>;
}

export type ReaderMcpDependencies = ProbeMcpDependencies & {
  readonly readerHtml: string;
  readonly service: ReaderMcpService;
};

export const ProbeBindingContextSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("unavailable") }).strict(),
  z.object({ status: z.literal("candidate"), bindingToken: OpaqueIdSchema }).strict(),
]);
export type ProbeBindingContext = z.infer<typeof ProbeBindingContextSchema>;

export const ProbeUiAttestationInputSchema = z
  .object({
    challenge: OpaqueIdSchema,
    sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
    fullscreenRequested: z.literal(true),
  })
  .strict();
export type ProbeUiObservation = { readonly resourceChallengeCompleted: true };

export type ProbeMcpDependencies = {
  readonly probeHtml: string;
  /** Synchronous trusted boundary; raw metadata must not cross into runProbe. */
  readonly captureHostContext?: (
    rawHostMetadata: RawHostRequestMetadata | undefined,
  ) => ProbeBindingContext;
  readonly runProbe: (
    binding: ProbeBindingContext,
    observation: ProbeUiObservation,
  ) => CapabilityProbeReport | Promise<CapabilityProbeReport>;
};

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const UI_RESOURCE_META = {
  ui: {
    csp: {
      connectDomains: [],
      resourceDomains: [],
      frameDomains: [],
    },
    prefersBorder: false,
  },
} as const;

const MAX_PENDING_UI_CHALLENGES = 32;
const UI_CHALLENGE_TTL_MS = 30_000;
const PROBE_HTML_MARKER = '<html lang="en"';

type PendingUiChallenge = {
  readonly sourceHash: string;
  readonly expiresAt: number;
};

function injectProbeChallenge(probeHtml: string, challenge: string): string {
  const first = probeHtml.indexOf(PROBE_HTML_MARKER);
  if (first < 0 || first !== probeHtml.lastIndexOf(PROBE_HTML_MARKER)) {
    throw new Error("PROBE_HTML_CHALLENGE_MARKER_INVALID");
  }
  return probeHtml.replace(
    PROBE_HTML_MARKER,
    `${PROBE_HTML_MARKER} data-aimd-probe-challenge="${challenge}"`,
  );
}

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function internalFailureReport(): CapabilityProbeReport {
  const sourcePeek = {
    uri: PROBE_SOURCE_URI,
    excerptHash: sha256Text(PROBE_SOURCE_TEXT),
  } as const;
  return CapabilityProbeReportSchema.parse({
    reportVersion: 1,
    gates: [
      {
        id: "P0-A",
        status: "failed",
        summary: "The capability probe failed at its trusted server boundary.",
        diagnosticCode: "PROBE_INTERNAL_FAILURE",
      },
      { id: "P0-B", status: "not_run", summary: "Exact task binding was not evaluated." },
      { id: "P0-C", status: "not_run", summary: "Ephemeral fork creation was not evaluated." },
      { id: "P0-D", status: "not_run", summary: "Context fidelity was not evaluated." },
      { id: "P0-E", status: "failed", summary: "The failure matrix did not complete." },
    ],
    featureFlags: {
      task_and_project: false,
      project_only: false,
      reader_only: false,
    },
    sourcePeek,
  });
}

const ReaderRootInputSchema = z.object({ rootId: OpaqueIdSchema }).strict();
const ReaderPathInputSchema = ReaderRootInputSchema.extend({ path: RelativePathSchema }).strict();
const ReaderSourceInputSchema = ReaderPathInputSchema.extend({
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
}).strict().superRefine((value, context) => {
  if (value.endLine < value.startLine) {
    context.addIssue({ code: "custom", path: ["endLine"], message: "endLine precedes startLine" });
  }
});
const ReaderQuestionInputSchema = z.object({
  sessionId: OpaqueIdSchema,
  question: z.object({
    question: z.string().min(1).max(16_384).refine((value) => value.trim().length > 0),
    startOffset: z.number().int().nonnegative(),
    endOffset: z.number().int().positive(),
  }).strict().superRefine((value, context) => {
    if (value.endOffset <= value.startOffset) {
      context.addIssue({ code: "custom", path: ["endOffset"], message: "Selection must be non-empty" });
    }
  }),
}).strict();
const ReaderPollInputSchema = z.object({
  runId: OpaqueIdSchema,
  cursor: z.object({
    runId: OpaqueIdSchema,
    generation: OpaqueIdSchema,
    sequence: z.number().int().positive(),
  }).strict().optional(),
}).strict().superRefine((value, context) => {
  if (value.cursor && value.cursor.runId !== value.runId) {
    context.addIssue({ code: "custom", path: ["cursor", "runId"], message: "Cursor runId must match runId" });
  }
});
const ReaderDispositionInputSchema = z.object({
  annotationId: OpaqueIdSchema,
  disposition: DispositionSchema,
}).strict();
const ReaderPreparePatchInputSchema = z.object({
  sessionId: OpaqueIdSchema,
  annotationIds: z.array(OpaqueIdSchema).min(1).max(256).refine(
    (ids) => new Set(ids).size === ids.length,
    "annotationIds must be unique",
  ),
}).strict();
const ReaderApproveInputSchema = z.object({
  sessionId: OpaqueIdSchema,
  sourceHash: Sha256DigestSchema,
  diffHash: Sha256DigestSchema,
}).strict();
const ReaderWriteInputSchema = z.object({
  sessionId: OpaqueIdSchema,
  previewId: OpaqueIdSchema,
  approvalToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
}).strict();

const APP_ONLY_READER_META = {
  ui: { resourceUri: READER_RESOURCE_URI, visibility: ["app"] },
} as const;

const READER_ERROR_CODES = new Set([
  "ROOT_NOT_FOUND",
  "DOCUMENT_NOT_FOUND",
  "SESSION_NOT_FOUND",
  "RUN_NOT_FOUND",
  "RUN_CAPACITY_EXCEEDED",
  "CURSOR_GAP",
  "CURSOR_INVALID",
  "EVENT_REPLAY_MISMATCH",
  "RUN_TERMINAL",
  "ANCHOR_STALE",
  "QUESTION_FAILED",
  "ANNOTATION_NOT_FOUND",
  "ANNOTATION_NOT_ACCEPTED",
  "PATCH_NOT_FOUND",
  "PATCH_NOT_APPROVABLE",
  "APPROVAL_INVALID",
  "SOURCE_CHANGED",
  "OUTPUT_ALREADY_EXISTS",
  "SAFE_WRITE_UNAVAILABLE",
  "SERVER_RESTARTED",
  "SERVICE_CLOSED",
  "ROOT_AUTHORIZATION_REVOKED",
  "MCP_ROOT_NOT_AUTHORIZED",
]);

function sanitizedReaderFailure(error: unknown) {
  let code = "READER_OPERATION_FAILED";
  if (typeof error === "object" && error !== null && !nodeUtilTypes.isProxy(error)) {
    try {
      const descriptor = Object.getOwnPropertyDescriptor(error, "code");
      if (
        descriptor &&
        "value" in descriptor &&
        typeof descriptor.value === "string" &&
        READER_ERROR_CODES.has(descriptor.value)
      ) {
        code = descriptor.value;
      }
    } catch {
      code = "READER_OPERATION_FAILED";
    }
  }
  return {
    isError: true,
    content: [{ type: "text" as const, text: "AIMD Reader operation failed safely." }],
    structuredContent: { status: "error", code },
  };
}

async function readerToolResult(
  operation: () => Promise<Record<string, unknown>>,
  message: string,
) {
  try {
    return {
      content: [{ type: "text" as const, text: message }],
      structuredContent: await operation(),
    };
  } catch (error) {
    return sanitizedReaderFailure(error);
  }
}

function registerReaderSurface(
  server: McpServer,
  dependencies: Pick<ReaderMcpDependencies, "readerHtml" | "service">,
): void {
  const observedMcpRoots = async (): Promise<readonly { readonly uri: string }[] | undefined> => {
    const protocol = server.server;
    if (!protocol.getClientCapabilities()?.roots) return undefined;
    const result = await protocol.listRoots(undefined, { timeout: 5_000, maxTotalTimeout: 5_000 });
    return result.roots.map((root) => ({ uri: root.uri }));
  };
  const authorizedRoots = async (): Promise<{
    readonly roots: unknown;
    readonly ids: ReadonlySet<string>;
  }> => {
    const roots = await dependencies.service.listRoots(await observedMcpRoots());
    const summaries = z.array(z.object({ rootId: OpaqueIdSchema }).passthrough()).max(64).parse(roots);
    return { roots, ids: new Set(summaries.map((summary) => summary.rootId)) };
  };
  const assertAuthorizedRoot = async (rootId: string): Promise<void> => {
    const { ids } = await authorizedRoots();
    if (!ids.has(rootId)) {
      const error = new Error("MCP_ROOT_NOT_AUTHORIZED") as Error & { code: string };
      error.code = "MCP_ROOT_NOT_AUTHORIZED";
      throw error;
    }
  };
  const assertAuthorizedAccess = async (
    kind: "session" | "run" | "annotation" | "preview",
    id: string,
  ): Promise<void> => {
    await dependencies.service.authorizeAccess({ kind, id }, await observedMcpRoots());
  };

  registerAppResource(
    server,
    "AIMD Reader",
    READER_RESOURCE_URI,
    {
      description: "Project-aware Markdown reader.",
      mimeType: RESOURCE_MIME_TYPE,
      _meta: UI_RESOURCE_META,
    },
    async () => ({
      contents: [{
        uri: READER_RESOURCE_URI,
        mimeType: RESOURCE_MIME_TYPE,
        text: dependencies.readerHtml,
        _meta: UI_RESOURCE_META,
      }],
    }),
  );

  registerAppTool(server, "aimd_open_reader", {
    title: "Open AIMD Reader",
    description: "Open the project-aware Markdown reader.",
    annotations: READ_ONLY_ANNOTATIONS,
    _meta: { ui: { resourceUri: READER_RESOURCE_URI, visibility: ["model", "app"] } },
  }, async () => textResult("AIMD Reader opened."));

  registerAppTool(server, "aimd_list_roots", {
    title: "List reader roots",
    description: "List opaque workspace roots available to the reader.",
    inputSchema: z.object({}).strict(),
    annotations: READ_ONLY_ANNOTATIONS,
    _meta: APP_ONLY_READER_META,
  }, async () => readerToolResult(async () => ({ roots: (await authorizedRoots()).roots }), "Reader roots loaded."));

  registerAppTool(server, "aimd_list_documents", {
    title: "List Markdown documents",
    description: "List bounded Markdown documents in one authorized root.",
    inputSchema: ReaderRootInputSchema,
    annotations: READ_ONLY_ANNOTATIONS,
    _meta: APP_ONLY_READER_META,
  }, async ({ rootId }) => readerToolResult(async () => {
    await assertAuthorizedRoot(rootId);
    return { documents: await dependencies.service.listDocuments(rootId) };
  }, "Markdown documents loaded."));

  registerAppTool(server, "aimd_read_document", {
    title: "Read Markdown document",
    description: "Read one Markdown document from an authorized root.",
    inputSchema: ReaderPathInputSchema,
    annotations: READ_ONLY_ANNOTATIONS,
    _meta: APP_ONLY_READER_META,
  }, async ({ rootId, path }) => readerToolResult(async () => {
    await assertAuthorizedRoot(rootId);
    return { document: await dependencies.service.openDocument(rootId, path) };
  }, "Markdown document loaded."));

  registerAppTool(server, "aimd_read_source", {
    title: "Read source excerpt",
    description: "Read a bounded source excerpt for citation inspection.",
    inputSchema: ReaderSourceInputSchema,
    annotations: READ_ONLY_ANNOTATIONS,
    _meta: APP_ONLY_READER_META,
  }, async ({ rootId, path, startLine, endLine }) => readerToolResult(async () => {
    await assertAuthorizedRoot(rootId);
    return { source: await dependencies.service.readSource(rootId, path, startLine, endLine) };
  }, "Source excerpt loaded."));

  registerAppTool(server, "aimd_create_session", {
    title: "Create reader session",
    description: "Bind a reader session to the current authorized workspace and document.",
    inputSchema: ReaderPathInputSchema,
    annotations: { ...READ_ONLY_ANNOTATIONS, readOnlyHint: false, idempotentHint: false },
    _meta: APP_ONLY_READER_META,
  }, async ({ rootId, path }, extra) => {
    let binding: unknown;
    try {
      // Reduce raw host metadata synchronously, before roots/list or any other await.
      binding = dependencies.service.captureSessionBinding(extra._meta);
    } catch (error) {
      return sanitizedReaderFailure(error);
    }
    return readerToolResult(async () => {
      await assertAuthorizedRoot(rootId);
      return { session: await dependencies.service.createSessionFromBinding(rootId, path, binding) };
    }, "Reader session created.");
  });

  registerAppTool(server, "aimd_ask_start", {
    title: "Ask about selection",
    description: "Start a project-grounded question job for one source selection.",
    inputSchema: ReaderQuestionInputSchema,
    annotations: { ...READ_ONLY_ANNOTATIONS, readOnlyHint: false, idempotentHint: false },
    _meta: APP_ONLY_READER_META,
  }, async ({ sessionId, question }) => readerToolResult(async () => {
    await assertAuthorizedAccess("session", sessionId);
    return { job: await dependencies.service.startQuestion(sessionId, question) };
  }, "Question started."));

  registerAppTool(server, "aimd_question_events", {
    title: "Read question events",
    description: "Poll sanitized cursor-based question progress and final output.",
    inputSchema: ReaderPollInputSchema,
    annotations: READ_ONLY_ANNOTATIONS,
    _meta: APP_ONLY_READER_META,
  }, async ({ runId, cursor }) => readerToolResult(async () => {
    await assertAuthorizedAccess("run", runId);
    return { page: await dependencies.service.pollQuestion(runId, cursor) };
  }, "Question events loaded."));

  registerAppTool(server, "aimd_cancel_question", {
    title: "Cancel question",
    description: "Cancel an active question job while retaining its draft.",
    inputSchema: z.object({ runId: OpaqueIdSchema }).strict(),
    annotations: { ...READ_ONLY_ANNOTATIONS, readOnlyHint: false, idempotentHint: true },
    _meta: APP_ONLY_READER_META,
  }, async ({ runId }) => readerToolResult(async () => {
    await assertAuthorizedAccess("run", runId);
    await dependencies.service.cancelQuestion(runId);
    return { status: "cancelled" };
  }, "Question cancelled."));

  registerAppTool(server, "aimd_set_disposition", {
    title: "Set annotation disposition",
    description: "Select how one reviewed annotation participates in synthesis.",
    inputSchema: ReaderDispositionInputSchema,
    annotations: { ...READ_ONLY_ANNOTATIONS, readOnlyHint: false, idempotentHint: true },
    _meta: APP_ONLY_READER_META,
  }, async ({ annotationId, disposition }) => readerToolResult(async () => {
    await assertAuthorizedAccess("annotation", annotationId);
    await dependencies.service.setDisposition(annotationId, disposition);
    return { status: "updated" };
  }, "Annotation disposition updated."));

  registerAppTool(server, "aimd_prepare_patch", {
    title: "Prepare reviewed patch",
    description: "Generate a source-bound Markdown patch preview from selected reviewed annotations.",
    inputSchema: ReaderPreparePatchInputSchema,
    annotations: { ...READ_ONLY_ANNOTATIONS, readOnlyHint: false, idempotentHint: false },
    _meta: APP_ONLY_READER_META,
  }, async ({ sessionId, annotationIds }) => readerToolResult(async () => {
    await assertAuthorizedAccess("session", sessionId);
    return { preview: await dependencies.service.preparePatch(sessionId, annotationIds) };
  }, "Patch preview prepared."));

  registerAppTool(server, "aimd_approve_patch", {
    title: "Approve exact patch",
    description: "Mint a short-lived approval bound to an exact source and diff.",
    inputSchema: ReaderApproveInputSchema,
    annotations: { ...READ_ONLY_ANNOTATIONS, readOnlyHint: false, idempotentHint: false },
    _meta: APP_ONLY_READER_META,
  }, async ({ sessionId, sourceHash, diffHash }) => readerToolResult(async () => {
    await assertAuthorizedAccess("session", sessionId);
    return { approval: await dependencies.service.approvePatch(sessionId, sourceHash, diffHash) };
  }, "Exact patch approved."));

  registerAppTool(server, "aimd_write_explained", {
    title: "Write explained Markdown sibling",
    description: "Create the approved .explained.md sibling without replacing the source.",
    inputSchema: ReaderWriteInputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    _meta: APP_ONLY_READER_META,
  }, async ({ sessionId, previewId, approvalToken }) => readerToolResult(async () => {
    await assertAuthorizedAccess("preview", previewId);
    await assertAuthorizedAccess("session", sessionId);
    return { result: await dependencies.service.writeExplained(sessionId, previewId, approvalToken) };
  }, "Explained Markdown created."));
}

/**
 * Creates the capability-probe surface and, when supplied, the reader surface.
 * Only the probe and session-binding callbacks may capture hidden host metadata;
 * render and all other data tools deliberately ignore request metadata.
 */
function createAimdMcpServer(
  dependencies: ProbeMcpDependencies,
  readerDependencies?: Pick<ReaderMcpDependencies, "readerHtml" | "service">,
): McpServer {
  const server = new McpServer(
    { name: "aimd-reader", version: "0.1.0" },
    { capabilities: { resources: {}, tools: {} } },
  );
  const sourceHash = sha256Text(PROBE_SOURCE_TEXT);
  const pendingUiChallenges = new Map<string, PendingUiChallenge>();

  const issueUiChallenge = (): string => {
    const now = Date.now();
    for (const [challenge, pending] of pendingUiChallenges) {
      if (pending.expiresAt <= now) pendingUiChallenges.delete(challenge);
    }
    while (pendingUiChallenges.size >= MAX_PENDING_UI_CHALLENGES) {
      const oldest = pendingUiChallenges.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      pendingUiChallenges.delete(oldest);
    }
    let challenge: string;
    do {
      challenge = OpaqueIdSchema.parse(`probe-${randomBytes(32).toString("base64url")}`);
    } while (pendingUiChallenges.has(challenge));
    pendingUiChallenges.set(challenge, {
      sourceHash,
      expiresAt: now + UI_CHALLENGE_TTL_MS,
    });
    return challenge;
  };

  const consumeUiChallenge = (
    input: z.infer<typeof ProbeUiAttestationInputSchema>,
  ): ProbeUiObservation => {
    const pending = pendingUiChallenges.get(input.challenge);
    // Atomic one-use consumption happens before any await in the tool handler.
    pendingUiChallenges.delete(input.challenge);
    if (
      !pending ||
      pending.expiresAt <= Date.now() ||
      pending.sourceHash !== input.sourceHash
    ) {
      throw new Error("PROBE_UI_CHALLENGE_INVALID");
    }
    return { resourceChallengeCompleted: true };
  };

  registerAppResource(
    server,
    "AIMD capability probe",
    PROBE_RESOURCE_URI,
    {
      description: "Self-contained fullscreen Phase 0 host capability probe.",
      mimeType: RESOURCE_MIME_TYPE,
      _meta: UI_RESOURCE_META,
    },
    async () => {
      const challenge = issueUiChallenge();
      return {
        contents: [
          {
            uri: PROBE_RESOURCE_URI,
            mimeType: RESOURCE_MIME_TYPE,
            text: injectProbeChallenge(dependencies.probeHtml, challenge),
            _meta: UI_RESOURCE_META,
          },
        ],
      };
    },
  );

  registerAppResource(
    server,
    "AIMD probe source peek",
    PROBE_SOURCE_URI,
    { description: "Hash-bound controlled source for the Phase 0 citation loop.", mimeType: "text/plain" },
    async () => ({
      contents: [{ uri: PROBE_SOURCE_URI, mimeType: "text/plain", text: PROBE_SOURCE_TEXT }],
    }),
  );

  registerAppTool(
    server,
    OPEN_PROBE_TOOL_NAME,
    {
      title: "Open AIMD capability probe",
      description: "Open the local AIMD Reader host capability probe.",
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        ui: {
          resourceUri: PROBE_RESOURCE_URI,
          visibility: ["model", "app"],
        },
      },
    },
    async () => textResult("AIMD capability probe opened."),
  );

  registerAppTool(
    server,
    PROBE_TOOL_NAME,
    {
      title: "Run AIMD capability probe",
      description: "Run sanitized host, task-context, isolation, and failure-matrix checks.",
      inputSchema: ProbeUiAttestationInputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        ui: {
          resourceUri: PROBE_RESOURCE_URI,
          visibility: ["app"],
        },
      },
    },
    async (attestation, extra) => {
      try {
        const observation = consumeUiChallenge(attestation);
        // Raw metadata exists only for this synchronous call. The captured
        // token is validated before any await and is the sole async input.
        const binding = ProbeBindingContextSchema.parse(
          dependencies.captureHostContext?.(
            extra._meta as RawHostRequestMetadata | undefined,
          ) ?? { status: "unavailable" },
        );
        const report = parseCapabilityProbeReport(
          await dependencies.runProbe(binding, observation),
        );
        return {
          content: [{ type: "text", text: "Capability probe completed." }],
          structuredContent: report,
        };
      } catch {
        const report = internalFailureReport();
        return {
          isError: true,
          content: [{ type: "text", text: "Capability probe failed safely." }],
          structuredContent: report,
        };
      }
    },
  );

  if (readerDependencies) registerReaderSurface(server, readerDependencies);
  return server;
}

export function createProbeMcpServer(dependencies: ProbeMcpDependencies): McpServer {
  return createAimdMcpServer(dependencies);
}

export function createReaderMcpServer(dependencies: ReaderMcpDependencies): McpServer {
  return createAimdMcpServer(dependencies, dependencies);
}
