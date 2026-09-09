import { z } from "zod";
import { type ArchitectureFailure, type ArchitectureIssue } from "@aimd/contracts";

const reasons = {
  ARCHITECTURE_OUT_OF_SCOPE: ["validation", "AI 修改了当前编辑范围之外的对象。", "选择「整个架构图」后重试，或将问题限定在当前关联区域。"],
  ARCHITECTURE_UNKNOWN_EVIDENCE: ["validation", "AI 引用了本次未提供的证据编号。", "重新提交问题；若反复发生，请复制诊断信息，检查模型返回的证据编号。"],
  ARCHITECTURE_DUPLICATE_ID: ["validation", "AI 返回了重复的对象标识。", "已有对象应作为修改返回，新对象需使用不同标识。可重试让 AI 重新生成。"],
  ARCHITECTURE_DISCONNECTED: ["validation", "新增结构没有连接到当前编辑区域。", "说明新增部分应连接到哪个模块，或切换到「整个架构图」。"],
  ARCHITECTURE_UNKNOWN_OBJECT: ["validation", "AI 引用的模块或连线不存在。", "重新提交问题，让 AI 使用当前图中的对象标识。"],
  ARCHITECTURE_INVALID_ENDPOINT: ["validation", "新增连线的端点无效。", "连线两端必须是已存在或本次新增的不同模块。"],
  ARCHITECTURE_GRAPH_LIMIT: ["validation", "修改后的图超出当前画布容量。", "当前最多容纳 12 个模块、24 条关系；请减少本次新增内容。"],
  ARCHITECTURE_OUTPUT_INVALID: ["validation", "AI 返回的数据格式不符合编辑协议。", "查看具体字段限制后重试；若重复发生，请复制诊断信息。"],
  ARCHITECTURE_SOURCE_CHANGED: ["evidence", "项目证据已变化或无法读取。", "重新生成架构后再提问；保存的旧图仍可查看和导出。"],
  ARCHITECTURE_LAYOUT_INVALID: ["rendering", "修改未通过 Archify 图形布局检查。", "根据下方布局问题减少新增内容或调整关系后重试。"],
  ARCHITECTURE_MODEL_FAILED: ["model", "Codex 未能完成本次模型调用。", "检查 Codex 连接后重试；请用请求编号定位服务日志。"],
  ARCHITECTURE_TIMEOUT: ["model", "本次请求超过运行时限。", "缩小问题范围后重试，或检查 Codex 连接。"],
  ARCHITECTURE_CANCELLED: ["model", "本次操作已取消。", "需要时重新提交问题。"],
  ARCHITECTURE_BUSY: ["model", "另一个架构问题仍在运行。", "等待当前请求结束后重试。"],
  ARCHITECTURE_TARGET_INVALID: ["request", "选中的对象不在当前架构中。", "重新选择模块或连线后提问。"],
  ARCHITECTURE_REQUEST_INVALID: ["request", "请求数据不符合接口要求。", "查看具体字段；尝试刷新页面后重新提交。"],
  ARCHITECTURE_NO_SOURCE: ["evidence", "未找到可用于生成架构的源文件。", "检查当前项目是否包含可读取的源代码。"],
  ARCHITECTURE_ORIGIN_FORBIDDEN: ["request", "请求来源未获允许。", "请从本地工作台页面发起操作。"],
  ARCHITECTURE_METHOD_INVALID: ["request", "架构接口只接受 POST 请求。", "请从工作台页面重试。"],
  ARCHITECTURE_PROJECT_CHANGED: ["request", "此地址连接的项目已变化。", "请重新连接项目；已保存的架构仍可查看。"],
  ARCHITECTURE_INTERNAL: ["internal", "架构服务发生未分类错误。", "请复制诊断信息，使用请求编号检查服务日志。"],
} as const;
type FailureCode = keyof typeof reasons;
export class ArchitectureError extends Error {
  repairAttempts = 0;
  constructor(readonly code: FailureCode, readonly issues: ArchitectureIssue[] = []) { super(code); }
}
// Only controlled descriptions and typed identifiers cross the public boundary.
// Raw exception messages, model output, stack traces and local executable paths never do.
export function architectureFailure(error: unknown, requestId: string): ArchitectureFailure {
  let code: FailureCode = "ARCHITECTURE_INTERNAL";
  let issues: ArchitectureIssue[] = [];
  if (error instanceof ArchitectureError) { code = error.code; issues = error.issues; }
  else if (error instanceof z.ZodError || error instanceof SyntaxError) { code = "ARCHITECTURE_REQUEST_INVALID"; if (error instanceof z.ZodError) issues = schemaIssues(error); }
  else if (error instanceof Error && Object.hasOwn(reasons, error.message)) code = error.message as FailureCode;
  const [stage, message, suggestion] = reasons[code];
  return { code, stage, message, suggestion, repairAttempts: error instanceof ArchitectureError ? error.repairAttempts : 0, issues: issues.slice(0, 12), requestId };
}
const knownFields = new Set(["answer", "nodeUpdates", "edgeUpdates", "addedNodes", "addedEdges", "limitations", "graph", "nodes", "edges", "notes", "target", "question", "scope", "operation", "id", "label", "kind", "summary", "detail", "evidenceIds", "sources", "path", "startLine", "endLine", "fileHash", "from", "to", "version", "title"]);
export function schemaIssues(error: z.ZodError): ArchitectureIssue[] {
  return error.issues.slice(0, 12).map(issue => ({
    code: "INVALID_FIELD", field: issue.path.map(part => typeof part === "number" ? String(part) : knownFields.has(String(part)) ? String(part) : "unknownField").join(".") || "response",
    message: issue.code === "too_big" ? `字段超过允许上限 ${String(issue.maximum)}。` : issue.code === "too_small" ? `字段未达到最小要求 ${String(issue.minimum)}。` : issue.code === "unrecognized_keys" ? "包含编辑协议未定义的字段。" : "字段缺失、类型不正确或格式无效。",
  }));
}
