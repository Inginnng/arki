import { useState } from "react";
import type { SideFailure } from "@aimd/contracts";
const stages = { request: "请求检查", task_context: "读取任务讨论", evidence: "读取文档与代码证据", model_setup: "创建模型会话", model: "等待模型回答" };
const causes = { CONNECTION_FAILED: "连接模型服务失败", STREAM_DISCONNECTED: "回答流中断", RATE_LIMIT: "用量或速率限制", AUTH_REQUIRED: "登录认证失败", CONTEXT_LIMIT: "上下文超限", SERVICE_UNAVAILABLE: "模型服务暂不可用", MODEL_ERROR: "模型服务错误" };
export class SideRequestError extends Error { constructor(readonly details: SideFailure) { super(details.code); } }
export function SideFailurePanel({ failure }: { failure: string | SideFailure }) {
  const [copyStatus, setCopyStatus] = useState("");
  if (typeof failure === "string") return <p className="inline-error" role="alert">{failure}</p>;
  const text = JSON.stringify(failure, null, 2);
  const copy = async () => { try { await navigator.clipboard.writeText(text); setCopyStatus("已复制诊断信息"); } catch { setCopyStatus("请在下方选择并复制诊断文本"); } };
  const { diagnostic } = failure;
  return <div className="inline-error inline-diagnostic" role="alert"><strong>{failure.message}</strong><p>{failure.suggestion}</p>
    <details><summary>查看排查详情</summary><dl>
      <dt>失败阶段</dt><dd>{stages[diagnostic.stage]}</dd><dt>运行耗时</dt><dd>{(diagnostic.elapsedMs / 1000).toFixed(1)} 秒</dd>
      <dt>连接重试</dt><dd>{diagnostic.retryCount} 次</dd>
      {diagnostic.lastErrorCode ? <><dt>最近错误</dt><dd>{causes[diagnostic.lastErrorCode]}（{diagnostic.lastErrorCode}）</dd></> : null}
      <dt>错误代码</dt><dd>{failure.code}</dd><dt>请求编号</dt><dd>{failure.requestId}</dd>
    </dl><button type="button" onClick={() => void copy()}>复制诊断信息</button><span role="status">{copyStatus}</span>
    {copyStatus.startsWith("请") ? <textarea aria-label="诊断文本" readOnly value={text} onFocus={event => event.target.select()} /> : null}</details></div>;
}
