import { z } from "zod";
import { SideDiagnosticSchema, type SideDiagnostic, type SideFailure } from "@aimd/contracts";
const reasons: Record<string, [string, string]> = {
  SIDE_TIMEOUT: ["本次 Markdown 问答超时。", "查看下方失败阶段；连接正常时可缩小问题范围后重试。"],
  SIDE_MODEL_FAILED: ["Codex 未能完成回答。", "查看下方模型错误类型和请求编号。"],
  SIDE_RUNTIME_UNAVAILABLE: ["本机 Codex 运行时不可用。", "检查后台服务和 Codex 登录状态后重试。"],
  SIDE_TASK_INVALID: ["任务选择已不可用。", "刷新任务列表并重新选择。"],
  SIDE_TASK_EXPIRED: ["任务选择已过期。", "刷新任务列表并重新选择。"],
  SIDE_TASK_EMPTY: ["该任务没有可用的已完成讨论。", "选择包含已完成讨论的任务。"],
  SIDE_BUSY: ["另一个问题正在运行。", "等待完成或取消后重试。"],
  SIDE_CANCELLED: ["问题已取消。", "需要时重新提交。"],
  SIDE_OUTPUT_INVALID: ["模型回答未通过格式或引用校验。", "重试；若重复出现，请复制诊断信息。"],
  SIDE_TOOL_BLOCKED: ["模型尝试了不允许的工具行为。", "本次回答已停止，可重新提交问题。"],
  CODEX_VERSION_UNSUPPORTED: ["当前 Codex 运行时不支持所选模型。", "使用兼容的 Codex 运行时重新启动服务。"],
  SIDE_SOURCE_CHANGED: ["文档或代码证据已变化。", "重新打开文档再提问。"],
  SIDE_SELECTION_INVALID: ["选区无效或过长。", "缩小选区后重试。"],
  SIDE_REQUEST_INVALID: ["请求数据不符合接口要求。", "刷新页面后重新提交。"],
  SIDE_ORIGIN_FORBIDDEN: ["请求来源未获允许。", "请从本地工作台发起操作。"],
  SIDE_METHOD_INVALID: ["接口只接受 POST 请求。", "请从本地工作台发起操作。"],
};
export function sideQuestionFailure(error: unknown, requestId: string, beganAt: number, operation: string): SideFailure {
  const code = error instanceof z.ZodError ? "SIDE_REQUEST_INVALID" : error instanceof Error && Object.hasOwn(reasons, error.message) ? error.message : "SIDE_RUNTIME_UNAVAILABLE";
  const parsed = SideDiagnosticSchema.safeParse((error as { diagnostic?: unknown } | null)?.diagnostic);
  const stage: SideDiagnostic["stage"] = operation === "ask" ? "evidence" : ["select", "list"].includes(operation) ? "task_context" : "request";
  const diagnostic = parsed.success ? parsed.data : { stage, elapsedMs: Math.max(0, Date.now() - beganAt), retryCount: 0 };
  let [message, suggestion] = reasons[code]!;
  if (["SIDE_TIMEOUT", "SIDE_MODEL_FAILED"].includes(code)) {
    if (["CONNECTION_FAILED", "STREAM_DISCONNECTED"].includes(diagnostic.lastErrorCode ?? "")) {
      message = code === "SIDE_TIMEOUT" ? "模型连接反复失败，最终超过等待时限。" : "模型连接失败或回答流中断。";
      suggestion = "检查本机代理是否运行；后台需能连接模型服务。代理设置改变后请重启本地后台。";
    } else if (diagnostic.lastErrorCode === "RATE_LIMIT") suggestion = "模型服务报告用量或速率限制，请检查当前额度或稍后重试。";
    else if (diagnostic.lastErrorCode === "AUTH_REQUIRED") suggestion = "模型服务要求认证，请检查 Codex 登录状态。";
  }
  return { code, message, suggestion, requestId, diagnostic };
}
