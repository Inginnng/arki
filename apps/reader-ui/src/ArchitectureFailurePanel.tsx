import { useState } from "react";
import type { ArchitectureFailure } from "@aimd/contracts";
const stages = { request: "请求检查", evidence: "读取代码证据", model: "模型调用", validation: "检查 AI 修改", rendering: "生成架构图", internal: "服务处理" };
export class ArchitectureRequestError extends Error {
  constructor(readonly failure: ArchitectureFailure) { super(failure.message); }
}
export function ArchitectureFailurePanel({ failure, graphPreserved }: { failure: ArchitectureFailure; graphPreserved: boolean }) {
  const [copyStatus, setCopyStatus] = useState("");
  const text = JSON.stringify(failure, null, 2);
  const copy = async () => { try { await navigator.clipboard.writeText(text); setCopyStatus("已复制诊断信息"); } catch { setCopyStatus("请在下方选择并复制诊断文本"); } };
  return <div className="architecture-error architecture-diagnostic" role="alert">
    <strong>{failure.message}{graphPreserved ? " 原图已保留。" : ""}</strong>
    <p>{failure.suggestion}</p>
    <details><summary>查看排查详情{failure.issues.length ? `（${failure.issues.length} 项）` : ""}</summary>
      <dl><dt>失败阶段</dt><dd>{stages[failure.stage]}</dd><dt>错误代码</dt><dd>{failure.code}</dd><dt>请求编号</dt><dd>{failure.requestId}</dd>{failure.repairAttempts ? <><dt>自动修正</dt><dd>已尝试 1 次，仍未通过</dd></> : null}</dl>
      {failure.issues.length ? <ul>{failure.issues.map((issue, index) => <li key={index}><strong>{issue.message}</strong>{issue.objectId ? <p>对象：<code>{issue.objectId}</code></p> : null}{issue.field ? <p>字段：<code>{issue.field}</code></p> : null}{issue.actual ? <p>实际：<code>{issue.actual}</code></p> : null}{issue.expected ? <p>允许：<code>{issue.expected}</code></p> : null}<small>{issue.code}</small></li>)}</ul> : null}
      <button type="button" onClick={() => void copy()}>复制诊断信息</button><span role="status">{copyStatus}</span>
      {copyStatus.startsWith("请") ? <textarea aria-label="诊断文本" readOnly value={text} onFocus={event => event.target.select()} /> : null}
    </details>
  </div>;
}
