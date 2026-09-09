import { App } from "@modelcontextprotocol/ext-apps";
import {
  EvidenceAnswerSchema,
  OpaqueIdSchema,
  QuestionRunPageSchema,
  ReaderSessionSchema,
  RelativePathSchema,
  Sha256DigestSchema,
  type Disposition,
  type QuestionRunPage,
  type ReaderSession,
} from "@aimd/contracts";
import { z } from "zod";

export const READER_TOOL_NAMES = [
  "aimd_list_roots", "aimd_list_documents", "aimd_read_document", "aimd_read_source",
  "aimd_create_session", "aimd_ask_start", "aimd_question_events", "aimd_cancel_question",
  "aimd_set_disposition", "aimd_prepare_patch", "aimd_approve_patch", "aimd_write_explained",
] as const;
export type ReaderToolName = typeof READER_TOOL_NAMES[number];

const HeadingSchema = z.object({ depth: z.number().int().min(1).max(6), text: z.string(), line: z.number().int().positive() }).strict();
const ReaderDocumentSchema = z.object({
  path: RelativePathSchema,
  hash: Sha256DigestSchema,
  markdown: z.string(),
  headings: z.array(HeadingSchema),
  anchorStatus: z.object({ status: z.string() }).passthrough(),
}).strict();
const SourcePeekSchema = z.object({
  path: RelativePathSchema,
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  totalLines: z.number().int().nonnegative(),
  lines: z.array(z.object({ line: z.number().int().positive(), text: z.string() }).strict()),
  excerpt: z.string(),
  fileHash: Sha256DigestSchema,
  truncated: z.boolean(),
}).strict();
const PatchPreviewSchema = z.object({
  id: OpaqueIdSchema, sessionId: OpaqueIdSchema, status: z.enum(["ready", "conflict"]),
  sourcePath: RelativePathSchema, targetPath: RelativePathSchema,
  sourceHash: Sha256DigestSchema, resultHash: Sha256DigestSchema, diffHash: Sha256DigestSchema,
  markdown: z.string(), unifiedDiff: z.string(), annotationIds: z.array(OpaqueIdSchema),
  conflicts: z.array(z.object({ annotationId: OpaqueIdSchema, reason: z.string() }).strict()),
}).strict();

export type ReaderRoot = { rootId: string; workspaceLabel: string; storageKey?: string };
export type ReaderDocumentSummary = { path: string; title: string; hash: string };
export type ReaderDocument = z.infer<typeof ReaderDocumentSchema>;
export type SourcePeek = z.infer<typeof SourcePeekSchema>;
export type PatchPreview = z.infer<typeof PatchPreviewSchema>;

const outputSchemas = {
  aimd_list_roots: z.object({ roots: z.array(z.object({ rootId: OpaqueIdSchema, workspaceLabel: z.string().min(1), storageKey: Sha256DigestSchema.optional() }).strict()) }).strict(),
  aimd_list_documents: z.object({ documents: z.array(z.object({ path: RelativePathSchema, title: z.string().min(1), hash: Sha256DigestSchema }).strict()) }).strict(),
  aimd_read_document: z.object({ document: ReaderDocumentSchema }).strict(),
  aimd_read_source: z.object({ source: SourcePeekSchema }).strict(),
  aimd_create_session: z.object({ session: ReaderSessionSchema }).strict(),
  aimd_ask_start: z.object({ job: z.object({ runId: OpaqueIdSchema }).strict() }).strict(),
  aimd_question_events: z.object({ page: QuestionRunPageSchema }).strict(),
  aimd_cancel_question: z.object({ status: z.literal("cancelled") }).strict(),
  aimd_set_disposition: z.object({ status: z.literal("updated") }).strict(),
  aimd_prepare_patch: z.object({ preview: PatchPreviewSchema }).strict(),
  aimd_approve_patch: z.object({ approval: z.object({ approvalToken: z.string() }).strict() }).strict(),
  aimd_write_explained: z.object({ result: z.object({ path: RelativePathSchema }).passthrough() }).strict(),
} satisfies Record<ReaderToolName, z.ZodType>;

export type ReaderAppPort = {
  connect(): Promise<void>;
  requestDisplayMode(params: { mode: "fullscreen" }): Promise<{ mode: string }>;
  callServerTool(params: { name: string; arguments: unknown }): Promise<{ isError?: boolean; content: readonly unknown[]; structuredContent?: unknown }>;
};

export class ReaderHostError extends Error {
  constructor(readonly code: string, message = "AIMD Reader 操作已安全停止。") {
    super(message);
    this.name = "ReaderHostError";
  }
}

export type ReaderHost = {
  connect(): Promise<void>;
  call<T = unknown>(tool: ReaderToolName, input: unknown): Promise<T>;
  requestFullscreen(): Promise<void>;
  openSource(rootId: string, path: string, line?: number): Promise<SourcePeek>;
  watchQuestion(runId: string, onPage: (page: QuestionRunPage) => void, signal: AbortSignal): Promise<void>;
};

function normalizedError(result: { isError?: boolean; structuredContent?: unknown }): ReaderHostError {
  const structured = result.structuredContent;
  if (typeof structured === "object" && structured !== null) {
    const record = structured as Record<string, unknown>;
    const nested = typeof record.error === "object" && record.error !== null ? record.error as Record<string, unknown> : record;
    if (typeof nested.code === "string") return new ReaderHostError(nested.code, typeof nested.message === "string" ? nested.message : undefined);
  }
  return new ReaderHostError("READER_OPERATION_FAILED");
}

export function createReaderHost(
  app: ReaderAppPort,
  options: { sleep?: (milliseconds: number) => Promise<void> } = {},
): ReaderHost {
  const sleep = options.sleep ?? ((milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const call = async <T,>(tool: ReaderToolName, input: unknown): Promise<T> => {
    let result;
    try {
      result = await app.callServerTool({ name: tool, arguments: input });
    } catch {
      throw new ReaderHostError("HOST_TRANSPORT_UNAVAILABLE");
    }
    if (result.isError) throw normalizedError(result);
    if (result.structuredContent === undefined) throw new ReaderHostError("HOST_RESPONSE_INVALID");
    const parsed = outputSchemas[tool].safeParse(result.structuredContent);
    if (!parsed.success) throw new ReaderHostError("HOST_RESPONSE_INVALID");
    return parsed.data as T;
  };
  return {
    connect: async () => await app.connect(),
    call,
    requestFullscreen: async () => {
      try { await app.requestDisplayMode({ mode: "fullscreen" }); } catch { /* inline is valid */ }
    },
    openSource: async (rootId, path, line = 1) => {
      const result = await call<{ source: SourcePeek }>("aimd_read_source", { rootId, path, startLine: line, endLine: line + 11 });
      return result.source;
    },
    watchQuestion: async (runId, onPage, signal) => {
      let cursor: QuestionRunPage extends never ? never : unknown;
      let failures = 0;
      try {
        while (!signal.aborted) {
          try {
            const result = await call<{ page: QuestionRunPage }>("aimd_question_events", { runId, ...(cursor ? { cursor } : {}) });
            failures = 0;
            onPage(result.page);
            if (result.page.outcome === "events") {
              cursor = result.page.nextCursor;
              if (result.page.events.some((event) => ["completed", "stale", "failed", "cancelled"].includes(event.type))) return;
            } else {
              cursor = result.page.outcome === "CURSOR_GAP" ? undefined : result.page.currentCursor;
            }
            await sleep(250);
          } catch (error) {
            if (error instanceof ReaderHostError && error.code !== "HOST_TRANSPORT_UNAVAILABLE") throw error;
            failures += 1;
            if (failures > 3) throw new ReaderHostError("HOST_TRANSPORT_UNAVAILABLE");
            await sleep(100 * failures);
          }
        }
      } finally {
        if (signal.aborted) await call("aimd_cancel_question", { runId }).catch(() => undefined);
      }
    },
  };
}

export function createCodexReaderHost(): ReaderHost {
  const app = new App({ name: "AIMD Reader", version: "0.1.0" }, {}, { strict: true, autoResize: false });
  return createReaderHost(app as unknown as ReaderAppPort);
}

export type ReaderToolOutputs = {
  roots: ReaderRoot[];
  documents: ReaderDocumentSummary[];
  session: ReaderSession;
  answer: z.infer<typeof EvidenceAnswerSchema>;
  patch: PatchPreview;
  source: SourcePeek;
  disposition: Disposition;
};
