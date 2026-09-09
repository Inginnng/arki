import type { ArchitectureFlow, ArchitectureGraph } from "@aimd/contracts";
import { flowTransitionName, type FlowScenario } from "./architecture-flows.js";

export function ArchitectureFlowPicker({ flows, flow, onChange }: { flows: FlowScenario[]; flow?: FlowScenario | undefined; onChange: (id: string) => void }) {
  return <div className="arki-flow-picker" aria-label="典型流程"><div className="arki-flow-chapters">{flows.map(item=><button key={item.id} aria-pressed={flow?.id===item.id} onClick={()=>onChange(item.id)}>{item.label}{item.issues?.length?" · 待核对":""}</button>)}</div>{flow?<p><strong>{flow.legacy?"旧版阅读主线 · ":"触发："}</strong>{flow.trigger}</p>:<p>尚未确认典型流程。已有组件结构仍可阅读；重新分析可从代码识别实际场景。</p>}</div>;
}
export function ArchitectureFlowReader({ graph, flow, stepId, transitionId, back, onStep, onTransition, onBack, onSource }: { graph: ArchitectureGraph; flow: ArchitectureFlow; stepId: string; transitionId?: string | undefined; back: boolean; onStep: (id: string) => void; onTransition: (id: string) => void; onBack: () => void; onSource: (path: string,line: number) => void }) {
  const current=flow.steps.find(step=>step.id===stepId)??flow.steps.find(step=>step.id===flow.entryStepId)!;
  const transition=flow.transitions.find(edge=>edge.id===transitionId);
  const outgoing=flow.transitions.filter(edge=>edge.from===current.id);
  const go=(id:string)=>onTransition(id);
  return <section className="arki-flow-reader" aria-label="流程步骤解读">
    <span className="architecture-eyebrow">SCENARIO / {flow.label}</span><p>{flow.summary}</p>
    {flow.issues?.length?<details className="arki-flow-issues" open><summary>此场景有 {flow.issues.length} 项待核对</summary>{flow.issues.map((issue,index)=><p key={index}>{issue}</p>)}</details>:null}
    <details className="arki-flow-directory"><summary>步骤目录 · {flow.steps.length} 步（编号不代表串行执行）</summary><ol>{flow.steps.map((step,index)=><li key={step.id}><button aria-pressed={current.id===step.id} onClick={()=>onStep(step.id)}>{index+1}. {step.label}<small>{graph.nodes.find(node=>node.id===step.nodeId)?.label}</small></button></li>)}</ol></details>
    <h2>{flow.steps.indexOf(current)+1}. {current.label}</h2><p className="architecture-summary">执行组件：{graph.nodes.find(node=>node.id===current.nodeId)?.label} · {current.kind==="decision"?"条件判断":current.kind==="result"?"结果":"操作"}</p>
    <dl className="arki-transfer-facts"><dt>收到什么</dt><dd>{current.input||"尚未细分"}</dd><dt>如何处理</dt><dd>{current.processing}</dd><dt>产出什么</dt><dd>{current.output||"尚未细分"}</dd></dl>
    <div className="architecture-sources"><span>步骤代码来源</span>{current.sources.map((ref,index)=><button key={index} onClick={()=>onSource(ref.path,ref.startLine)}>{ref.path}:{ref.startLine}</button>)}</div>
    {transition?<div className="arki-flow-transfer" role="status"><strong>关系 {flow.transitions.indexOf(transition)+1} · {flowTransitionName[transition.kind]}</strong><p>{flow.steps.find(step=>step.id===transition.from)?.label} → {flow.steps.find(step=>step.id===transition.to)?.label}</p>{transition.condition?<p>条件：{transition.condition}</p>:null}<dl><dt>传输数据</dt><dd>{transition.payload}</dd><dt>调用方式</dt><dd>{transition.mechanism}</dd></dl><div className="architecture-sources">{transition.sources.map((ref,index)=><button key={index} onClick={()=>onSource(ref.path,ref.startLine)}>{ref.path}:{ref.startLine}</button>)}</div></div>:null}
    <div className="arki-flow-navigation"><button disabled={!back} onClick={onBack}>上一步</button><button onClick={()=>onStep(flow.entryStepId)}>回到入口</button></div>
    {outgoing.some(edge=>edge.kind==="parallel")?<p className="arki-flow-note">这里包含并行分支；选择一条查看，不表示其他分支随后执行。</p>:null}
    {outgoing.length?<div className="arki-flow-branches"><strong>{outgoing.length>1?"选择要了解的后续分支":"沿已确认关系继续"}</strong>{outgoing.map(edge=><button key={edge.id} onClick={()=>go(edge.id)}><span>{flowTransitionName[edge.kind]}{edge.condition?" · "+edge.condition:""} → {flow.steps.find(step=>step.id===edge.to)?.label}</span><small>{edge.payload}</small></button>)}</div>:<p className="arki-flow-note">{current.kind==="result"?"当前路径到达已记录的结果。":"没有已确认的后续连接；不能据此断言流程结束。"}</p>}
  </section>;
}
