# AIMD Reader：项目流程与实现方式

> 历史设计说明：产品现已更名为 **Arki · 一览**。2026-09-08 的架构分析、启动与恢复行为以 [当前工作台说明](inline-reading-status.zh-CN.md) 和 [能力报告](capability-report.md) 为准；以下保留早期 Markdown Reader 的设计与代码阅读示例。

> 本文把当前项目的真实实现、浏览器 Mock 演示和仍受宿主能力限制的部分分开说明。项目事实均附源码路径与行号。

## 1. 项目定位

AIMD Reader 是一个面向 Codex Desktop 的 Markdown 阅读与解释插件。插件清单声明了 Reader UI 和本地 MCP 服务入口。[plugins/aimd-reader/.codex-plugin/plugin.json:2-32](../plugins/aimd-reader/.codex-plugin/plugin.json#L2-L32) [plugins/aimd-reader/.mcp.json:1-9](../plugins/aimd-reader/.mcp.json#L1-L9)

它不会让模型直接修改项目文档。模型回答必须经过证据审核，用户还要审阅精确 diff；最终写入器只允许新建同目录的 `*.explained.md` 文件。[packages/workspace-server/src/service.ts:655-802](../packages/workspace-server/src/service.ts#L655-L802) [packages/workspace-server/src/safe-writer.ts:250-280](../packages/workspace-server/src/safe-writer.ts#L250-L280)

当前能力状态是“分入口安全降级”：打包插件仍等待宿主证明 exact-task 与空工具面；实验性本地网页入口已经可以把问题交给本机 Codex CLI 并展示项目证据，但固定为 `project_only`，且不会把结果标成独立审核通过。[packages/workspace-server/src/codex-cli-bridge.ts:82-102](../packages/workspace-server/src/codex-cli-bridge.ts#L82-L102) [packages/workspace-server/src/codex-cli-bridge.ts:169-178](../packages/workspace-server/src/codex-cli-bridge.ts#L169-L178) [docs/capability-report.md](./capability-report.md)

### 1.1 MCP 是什么

MCP 的全称是 **Model Context Protocol（模型上下文协议）**。它用统一协议连接 AI 应用与外部上下文、工具和服务；官方架构把参与者分成 Host、Client 与 Server，Server 可以暴露 resources、tools 和 prompts。[MCP 官方架构说明](https://modelcontextprotocol.io/specification/2025-11-25)

在 AIMD Reader 的 Codex Desktop 入口中，Reader UI 通过 MCP Apps host adapter 进行白名单调用，本地 MCP server 再提供 Reader 资源和项目工具。[apps/reader-ui/src/host.ts:105-116](../apps/reader-ui/src/host.ts#L105-L116) [packages/workspace-server/src/mcp.ts:328-413](../packages/workspace-server/src/mcp.ts#L328-L413)

实验性普通网页入口不是让浏览器直接执行 MCP 或任意命令：页面只调用同源的 `/api/health` 与 `/api/reader`，本地网关再复用 Reader 服务并调用固定的 Codex CLI runner。[apps/reader-ui/src/http-host.ts:15-37](../apps/reader-ui/src/http-host.ts#L15-L37) [packages/workspace-server/src/web-gateway.ts:263-292](../packages/workspace-server/src/web-gateway.ts#L263-L292) [scripts/start-web.mts:56-81](../scripts/start-web.mts#L56-L81)

## 2. 整体流程

### 2.1 打开 Markdown

Reader UI 获取宿主授权的工作区，枚举其中的 Markdown 文件；选择文档后并行读取文档和创建阅读会话，并用文档代际避免迟到响应覆盖新文档。[apps/reader-ui/src/App.tsx:226-278](../apps/reader-ui/src/App.tsx#L226-L278) [packages/workspace-server/src/mcp.ts:354-413](../packages/workspace-server/src/mcp.ts#L354-L413)

### 2.2 选择原文并提问

Markdown 元素保留解析器生成的源码偏移。用户选中文字后，UI 把 DOM Range 映射为 `startOffset/endOffset`，不会通过全篇模糊匹配猜测位置。[apps/reader-ui/src/App.tsx:103-137](../apps/reader-ui/src/App.tsx#L103-L137) [apps/reader-ui/src/App.tsx:298-309](../apps/reader-ui/src/App.tsx#L298-L309) [apps/reader-ui/src/selection.ts:50-78](../apps/reader-ui/src/selection.ts#L50-L78)

提问请求只携带会话 ID、问题文本和选区偏移；UI 同步阻止重复提交，并把迟到的旧文档问题安全取消。[apps/reader-ui/src/App.tsx:337-382](../apps/reader-ui/src/App.tsx#L337-L382)

### 2.3 建立可信上下文

服务端重新读取当前文件并创建带文件哈希的源码锚点，防止浏览器伪造文件内容或继续引用已经变化的文本。[packages/workspace-server/src/service.ts:523-575](../packages/workspace-server/src/service.ts#L523-L575) [packages/reader-core/src/anchor.ts:267-354](../packages/reader-core/src/anchor.ts#L267-L354)

当前 Codex task 绑定只能来自隐藏的宿主元数据。元数据冲突、非法或不可用时，系统不会根据 cwd、标题或最近任务猜测，而是显式降级。[packages/workspace-server/src/mcp.ts:395-412](../packages/workspace-server/src/mcp.ts#L395-L412) [packages/app-server-bridge/src/metadata.ts:80-152](../packages/app-server-bridge/src/metadata.ts#L80-L152)

### 2.4 获取项目证据并回答

标准 Reader 服务先签发初始证据包，再把问题交给当前 bridge。完整 Codex Desktop 合同允许模型只通过类型化输出请求最多两轮额外证据；实验性网页 bridge 使用后文所述的 answer-only 兼容分支，不执行这两轮扩证。[packages/workspace-server/src/service.ts:830-874](../packages/workspace-server/src/service.ts#L830-L874) [packages/reader-core/src/evidence.ts:356-374](../packages/reader-core/src/evidence.ts#L356-L374) [packages/workspace-server/src/codex-cli-bridge.ts:44-73](../packages/workspace-server/src/codex-cli-bridge.ts#L44-L73)

### 2.5 审核答案

完整生产流程要求校验运行 ID、代际、文件哈希、摘录哈希和项目快照，并经过独立支持性审核；文件变化会让结果变为 `stale`。[packages/workspace-server/src/service.ts:882-995](../packages/workspace-server/src/service.ts#L882-L995) [packages/reader-core/src/evidence.ts:964-1065](../packages/reader-core/src/evidence.ts#L964-L1065)

实验性网页 bridge 目前只完成结构化输出和已签发 evidence ID 校验；它故意让独立审核返回 `MODEL_ISOLATION_UNPROVEN`，所以页面不会把回答标成 `evidence_reviewed`，也不会开放后续合成与写入。[packages/workspace-server/src/codex-cli-bridge.ts:135-178](../packages/workspace-server/src/codex-cli-bridge.ts#L135-L178)

UI 使用带 cursor 的事件流接收进度和终态，并处理取消、事件缺口和安全失败。[apps/reader-ui/src/host.ts:128-153](../apps/reader-ui/src/host.ts#L128-L153) [apps/reader-ui/src/App.tsx:312-395](../apps/reader-ui/src/App.tsx#L312-L395)

### 2.6 选择处置方式

通过审核的回答默认仍是 `reading_only`。用户必须显式选择 `inline`、`replace`、`glossary`、`faq` 或 `ignore`；改变处置会使旧审批失效。[apps/reader-ui/src/App.tsx:404-412](../apps/reader-ui/src/App.tsx#L404-L412) [packages/workspace-server/src/service.ts:642-649](../packages/workspace-server/src/service.ts#L642-L649)

### 2.7 生成并审批精确 diff

`preparePatch` 会拒绝过期、未审核、被忽略或仍为只读的注释，并在合成前后重新检查源文件和项目快照。模型生成的编辑还必须覆盖准确的注释集合、匹配处置类型，并且只能引用授权证据。[packages/workspace-server/src/service.ts:655-748](../packages/workspace-server/src/service.ts#L655-L748) [packages/reader-core/src/synthesis.ts:375-432](../packages/reader-core/src/synthesis.ts#L375-L432)

UI 默认使用中文，并同时展示“原文”“生成结果”和“统一差异”。审批令牌绑定 `sessionId + sourceHash + diffHash + targetPath`，默认十分钟有效并且只能成功消费一次。[apps/reader-ui/src/App.tsx:534-544](../apps/reader-ui/src/App.tsx#L534-L544) [apps/reader-ui/index.html:2-7](../apps/reader-ui/index.html#L2-L7) [packages/reader-core/src/approval.ts:11-27](../packages/reader-core/src/approval.ts#L11-L27) [packages/reader-core/src/approval.ts:200-269](../packages/reader-core/src/approval.ts#L200-L269)

### 2.8 新建解释文档

真正写入前，服务端再次检查源哈希、结果哈希、diff 哈希和全部已接受证据。[packages/workspace-server/src/service.ts:786-802](../packages/workspace-server/src/service.ts#L786-L802) [packages/workspace-server/src/service.ts:1095-1132](../packages/workspace-server/src/service.ts#L1095-L1132)

Windows 安全写入 helper 使用 `FileMode.CreateNew`，目标已存在就返回错误；它从不把源 Markdown 路径作为写入目标。[packages/workspace-server/src/safe-writer.ts:423-465](../packages/workspace-server/src/safe-writer.ts#L423-L465) [scripts/safe-write-windows.ps1:145-220](../scripts/safe-write-windows.ps1#L145-L220)

## 3. 实现分层

- **Reader UI**：React/Vite 页面、Markdown 渲染、选区映射和白名单 MCP 调用。[apps/reader-ui/src/host.ts:54-116](../apps/reader-ui/src/host.ts#L54-L116)
- **Contracts**：使用 Zod 定义会话、证据、回答和事件的公共数据边界。[packages/contracts/src/index.ts:1168-1191](../packages/contracts/src/index.ts#L1168-L1191) [packages/contracts/src/index.ts:1294-1349](../packages/contracts/src/index.ts#L1294-L1349)
- **App Server Bridge**：验证隐藏上下文、读取指定 thread、创建临时 side task并检查模型隔离。[packages/app-server-bridge/src/bridge.ts:950-1163](../packages/app-server-bridge/src/bridge.ts#L950-L1163)
- **Reader Core**：实现锚点、证据审核、Markdown 合成和审批逻辑。[packages/reader-core/src/anchor.ts:267-354](../packages/reader-core/src/anchor.ts#L267-L354) [packages/reader-core/src/synthesis.ts:375-432](../packages/reader-core/src/synthesis.ts#L375-L432)
- **Workspace Server**：拥有授权文件访问、持久化、MCP 工具和安全写入。[packages/workspace-server/src/mcp.ts:330-493](../packages/workspace-server/src/mcp.ts#L330-L493) [packages/workspace-server/src/store.ts:431-445](../packages/workspace-server/src/store.ts#L431-L445)

## 4. Mock、Codex Desktop 与真实本地网页

`/mock.html` 注入 `createMockReaderHost()`，用于在普通浏览器中演示完整 UI 交互；当前 Mock 通过 Vite raw import 直接读取本文，而不是再复制一份内嵌 Markdown。端到端测试同时覆盖中文桌面工作流和移动端选区后不跳页的提问入口。[apps/reader-ui/src/mock-main.tsx:1-14](../apps/reader-ui/src/mock-main.tsx#L1-L14) [apps/reader-ui/src/mock-host.ts:3-19](../apps/reader-ui/src/mock-host.ts#L3-L19) [tests/e2e/reader.spec.ts:3-88](../tests/e2e/reader.spec.ts#L3-L88)

Mock 的上下文、回答和审批结果是模拟数据；“写入成功”只返回路径，不触碰文件系统。因此 Mock 能证明浏览器交互，但不能证明真实 task 绑定、模型证据审核或安全写入已经发生。[apps/reader-ui/src/mock-host.ts:23-170](../apps/reader-ui/src/mock-host.ts#L23-L170)

页面顶部会把该入口明确标成“模拟后端 · 固定数据 · 不会调用 Codex”，避免把固定回答误认为真实模型输出。[apps/reader-ui/src/mock-main.tsx:14-20](../apps/reader-ui/src/mock-main.tsx#L14-L20)

生产入口使用真实 Codex MCP Apps host，并由本地 MCP 服务提供 `ui://aimd/reader.html`。[apps/reader-ui/src/main.tsx:10](../apps/reader-ui/src/main.tsx#L10) [apps/reader-ui/src/host.ts:158-160](../apps/reader-ui/src/host.ts#L158-L160) [packages/workspace-server/src/mcp.ts:328-352](../packages/workspace-server/src/mcp.ts#L328-L352)

当前生产客户端无法从现有 App Server 协议获得可验证的“空有效模型工具面”证明，所以会返回 `MODEL_ISOLATION_UNPROVEN`，不会启动模型 turn。[packages/app-server-bridge/src/isolation.ts:41-69](../packages/app-server-bridge/src/isolation.ts#L41-L69) [packages/app-server-bridge/src/client.ts:263-265](../packages/app-server-bridge/src/client.ts#L263-L265)

`/web.html` 是新增的真实本地网页入口，顶部显示“真实后端 · 本机 Codex CLI”。它通过同源 HTTP host 调用本地网关；网关只接受白名单 Reader 方法，并把启动时固定的项目根交给现有 `ProductionReaderService`。[apps/reader-ui/src/web-main.tsx:14-20](../apps/reader-ui/src/web-main.tsx#L14-L20) [packages/workspace-server/src/web-gateway.ts:15-33](../packages/workspace-server/src/web-gateway.ts#L15-L33) [packages/workspace-server/src/web-gateway.ts:168-292](../packages/workspace-server/src/web-gateway.ts#L168-L292) [scripts/start-web.mts:50-81](../scripts/start-web.mts#L50-L81)

Codex CLI runner 在不含项目文件的隔离临时目录中运行；目录内只有服务端策略和输出 schema，问题只经 stdin 传入。进程使用 `read-only`、`ephemeral` 和不继承 shell 环境的配置。JSONL 一旦出现 command、file change、web search 或 MCP tool item，就返回 `TOOL_ISOLATION_BROKEN`。[packages/workspace-server/src/codex-cli-runner.ts:84-123](../packages/workspace-server/src/codex-cli-runner.ts#L84-L123) [packages/workspace-server/src/codex-cli-runner.ts:234-283](../packages/workspace-server/src/codex-cli-runner.ts#L234-L283)

本机 Codex 0.152.0 的结构化输出不接受原问题合同的顶层 answer/evidence-request `oneOf`，所以网页适配器传递兼容的 answer-only 分支；证据不足时必须写入 `unknowns`，而不是编造事实。[packages/workspace-server/src/codex-cli-bridge.ts:44-73](../packages/workspace-server/src/codex-cli-bridge.ts#L44-L73) [packages/workspace-server/src/codex-cli-bridge.ts:120-148](../packages/workspace-server/src/codex-cli-bridge.ts#L120-L148)

这条网页链路仍不等于生产插件的 exact-task 模式：它固定声明 task context unavailable；独立审核与模型合成返回 `MODEL_ISOLATION_UNPROVEN`。由于回答不会成为 `evidence_reviewed` 注释，UI 不提供合成入口，安全写入也无法从该网页问答路径抵达。[packages/workspace-server/src/codex-cli-bridge.ts:82-102](../packages/workspace-server/src/codex-cli-bridge.ts#L82-L102) [packages/workspace-server/src/codex-cli-bridge.ts:169-178](../packages/workspace-server/src/codex-cli-bridge.ts#L169-L178) [apps/reader-ui/src/App.tsx:205-205](../apps/reader-ui/src/App.tsx#L205) [apps/reader-ui/src/App.tsx:414-423](../apps/reader-ui/src/App.tsx#L414-L423)

## 5. 与“网页调用本地 Agent”方案的关系

现在已经落地为两种 host adapter：

~~~text
Codex Desktop → MCP Apps host → 本地 MCP server ┐
                                                ├→ ProductionReaderService → 证据/审批/安全写入
普通浏览器 → 同源 HTTP host → localhost gateway ┘
                                                     ↓
                                               Codex CLI runner
~~~

UI 只依赖统一的 `ReaderHost` 接口；真实网页与 Mock 分别注入 HTTP host 和 Mock host。因此后续适配其他 Agent 时，优先新增一个 `StructuredAgentRunner`/bridge 实现，而不是重写选区、证据、diff 与安全写入逻辑。[apps/reader-ui/src/host.ts:80-91](../apps/reader-ui/src/host.ts#L80-L91) [apps/reader-ui/src/web-main.tsx:14-20](../apps/reader-ui/src/web-main.tsx#L14-L20) [packages/workspace-server/src/codex-cli-runner.ts:47-50](../packages/workspace-server/src/codex-cli-runner.ts#L47-L50) [packages/workspace-server/src/codex-cli-bridge.ts:75-178](../packages/workspace-server/src/codex-cli-bridge.ts#L75-L178)

**取舍结论：** “网页直接拼命令”不适合扩展；“网页 → 固定本地网关 → 统一 Agent runner”更适合多 Agent。它把浏览器输入、工作区授权、Agent 进程参数、证据验证和错误脱敏分成独立边界。当前先只实现 Codex runner，其他 Agent 后续沿同一接口接入。[packages/workspace-server/src/web-gateway.ts:168-292](../packages/workspace-server/src/web-gateway.ts#L168-L292) [packages/workspace-server/src/codex-cli-runner.ts:39-64](../packages/workspace-server/src/codex-cli-runner.ts#L39-L64)

## 6. 本地验证命令

项目提供完整检查、浏览器端到端测试和确定性准确性测试脚本：[package.json:10-19](../package.json#L10-L19)

```powershell
pnpm dev:web
pnpm check
pnpm test:e2e
pnpm test:accuracy
```

`pnpm dev:web` 只监听 `127.0.0.1:5173`，真实入口是 `http://127.0.0.1:5173/web.html`；`/mock.html` 仍仅用于固定数据的 UI 测试。[package.json:11](../package.json#L11) [scripts/start-web.mts:105-112](../scripts/start-web.mts#L105-L112)
