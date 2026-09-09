# Codex 侧边问答可行性实测报告

更新：2026-09-05 11:19（香港时间）。

**本报告记录此前两个受控样例：临时分支与相关片段模式均能回答。后续网页接线与验证状态见[中文实现进度](web-side-question-status.zh-CN.md)，不要把这里的探针成功当作网页端到端验收。**

## 1. 本轮定位到的失败原因

首轮使用 PATH 中的 Codex CLI 0.152.0，模型请求先反复断流、超时。本轮增加脱敏错误记录后，服务端最终明确拒绝：当前 gpt-6-astra 模型需要更新版本的 Codex。该错误现在单独分类为 CODEX_VERSION_UNSUPPORTED，而非仅归为泛化连接错误。代码：`tests/live/side-question-probe.mts:36`。

只读检查还发现 Windows 已启用本地代理，但测试进程没有 HTTP_PROXY、HTTPS_PROXY 等变量。最初无认证 HEAD 对照两路都超时；随后代理隧道和 TLS 连接成功，站点返回 403 挑战。这个 403 只证明该次网络请求到达了站点，不证明模型可用。旧 CLI 在显式代理与原环境两种运行下最终都返回版本拒绝，因此不能把所有失败简单归因于代理。

本机已经安装桌面运行时 0.153.3。保持同一模型 gpt-6-astra，并仅给测试进程传入用户原有本地代理后，真实模型回合和后续问答成功。本轮没有升级软件、更换模型、修改全局代理或认证配置。

注意：本轮探针显式指定了旧 CLI，这不等于已证明正式网页会选择旧 CLI。正式运行器的候选顺序本来就先扫描桌面目录再扫描 PATH；启动脚本也支持显式 --codex。证据：`packages/workspace-server/src/codex-cli-runner.ts:299`、`packages/workspace-server/src/codex-cli-runner.ts:325`、`scripts/start-web.mts:38`。

## 2. 两组真实模型测试

测试创建专用非敏感任务，不读取或猜测桌面当前任务。基础样例含随机代号、批次 37、原因“上限 40 且预留 3”、数据库未定，以及 60 行无关历史。变更样例增加真实的第二轮讨论：批次改为 25，因为上限变成 28，旧值 37 作废。代码：`tests/live/side-question-probe.mts:150`、`tests/live/side-question-probe.mts:161`。

每组分别测试：

- **临时分支：** 以最后一个已完成回合为截止位置创建 ephemeral fork，再提问，不把答案预先放进本次问题。代码：`tests/live/side-question-probe.mts:169`。
- **相关片段：** 新建临时任务，从测试任务的原始用户消息中提取已知相关行后提问。它是受控片段选择，不是已经实现的通用检索器。代码：`tests/live/side-question-probe.mts:181`。

| 样例 / 方式 | 输入 token | 输出 token | 问答耗时 | 实际答案与检查 |
| --- | ---: | ---: | ---: | --- |
| 基础 / 临时分支 | 15,362 | 47 | 6.292 秒 | 随机代号匹配；批次 37；原因正确；数据库 null |
| 基础 / 相关片段（66 字符） | 14,166 | 47 | 6.462 秒 | 同上 |
| 决策变更 / 临时分支 | 15,440 | 50 | 8.614 秒 | 随机代号匹配；新批次 25；原因对应新上限 28；数据库 null |
| 决策变更 / 相关片段（132 字符） | 14,220 | 64 | 7.197 秒 | 同上，并明确此前的 37 已废弃 |

基础运行于 11:13:40 开始，变更运行于 11:17:01 开始；两次完整进程退出码均为 0。上述四次问答的 cachedInputTokens 均为 0。耗时只对应各次侧边问题，不包括建立样例、初始化、分支创建等时间。

字段检查为随机代号、当前批次和数据库未知值的精确比较；变更样例中的决策原因已对照模型实际输出检查，但不是独立人工标注团队的评测。字段不匹配时，当前探针以 ANSWER_CHECK_FAILED 失败退出。证据：`tests/live/side-question-probe.mts:175`、`tests/live/side-question-probe.mts:187`。

## 3. 主任务是否受到影响

在临时分支问答前后，比较来源任务的完整可见 turns 序列：

- 基础样例：1 个已完成回合，哈希前后相同。
- 决策变更样例：2 个已完成回合，哈希前后相同。

这比首轮“空 turns 列表前后相同”更有意义：本轮确有真实完成回合。但它仍然只证明这两次测试中来源任务的可见回合未改变，不证明主任务所有隐藏运行状态、文件系统、工具或并发状态完全隔离。比较与失败断言：`tests/live/side-question-probe.mts:179`。

两组侧边问答观察到的 item 类型均为 userMessage、agentMessage。未见工具调用不等于严格工具隔离已被证明。脚本关闭多类工具并使用只读配置，但这仍是配置和有限观测，不是宿主能力证明。配置：`tests/live/side-question-probe.mts:45`。

测试只归档自己创建的来源任务，并关闭本次 App Server 进程。清理代码：`tests/live/side-question-probe.mts:197`；本次各运行均记录 fixture_archived。

## 4. 对“共用上下文”的实际结论

你的需求不需要“完整复制所有历史”作为前提。两个小样例表明：保留相关原始讨论片段，也能得到与继承历史分支一致的关键答案，包括处理后续决定覆盖旧决定。

不过，本次相关片段方式的输入 token 只分别减少约 **7.8% 和 7.9%**，不是数量级下降。输入总量还包含运行时指令等固定开销；本轮没有进一步拆解这些开销。耗时也没有稳定优势，不能据此承诺更快或更便宜。

官方将 /side、/btw 描述为临时侧聊；本次没有执行交互式 CLI 的这两个命令，而是测试可用于实现类似体验的 App Server 临时分支。[官方命令文档](https://learn.chatgpt.com/docs/developer-commands?surface=cli)

excludeTurns 控制向客户端返回的历史载荷，不等于减少模型继承的历史；lastTurnId 控制截止回合，不负责按问题检索相关内容。本次分支返回 turns 为空，却仍能答出历史中的随机代号，也与这个区别相符。[官方 App Server 文档](https://learn.chatgpt.com/docs/app-server)

**由本轮探针得出的方向：中文网页提供侧边问答；默认使用选区、必要邻近文档、可追溯的相关讨论和当前代码证据。** 后续实现与未完成边界另见[中文实现进度](web-side-question-status.zh-CN.md)。

## 5. 尚未验证或实现的部分

- 正式网页的任务选择、侧聊接入与完整用户流程。
- 真实项目中概念解释、源码引用支持结论的准确率，以及独立审核和解释版生成。
- 通用相关内容检索、上下文预算、去重、遗漏检测和多轮侧聊记忆管理。
- 超长历史、上下文压缩、并发中的主任务、恶意项目文本和稳定重连。
- 精确桌面当前任务自动绑定、严格工具隔离或完整隐藏状态隔离。

这两个样例只是受控可行性证据，不替代项目既有能力门禁或独立人工准确性评测。正式业务代码没有因本次测试而切换到新的侧聊实现。

## 6. 复现与回归验证

从项目根目录运行。使用已验证支持所选模型的本机原生 CLI。代理仅在环境确实需要时传入，并沿用用户已有代理；不要覆盖全局设置或写入报告中的固定机器路径。

```powershell
# 如需要，在当前 PowerShell 进程中设置已有代理；地址是占位符
$env:HTTPS_PROXY = '<已有代理 URL>'
$env:HTTP_PROXY = '<已有代理 URL>'

pnpm exec tsx tests/live/side-question-probe.mts --codex '<兼容的 Codex 原生可执行文件绝对路径>'
pnpm exec tsx tests/live/side-question-probe.mts --revised-decision --codex '<兼容的 Codex 原生可执行文件绝对路径>'

pnpm exec tsc --noEmit --module nodenext --moduleResolution nodenext --target es2022 --skipLibCheck tests/live/side-question-probe.mts
pnpm exec vitest run packages/app-server-bridge/src/jsonl.test.ts packages/workspace-server/src/codex-cli-runner.test.ts
```

本轮脚本类型检查通过；上述 2 个回归测试文件共 **35 项测试通过**。本轮未运行 pnpm check、浏览器端到端或项目准确性测试，不对这些完整门禁作新声明。

## 7. 首轮历史与修正

首轮 0.152.0 的两次真模型调用失败，不能评估答案；本轮补充诊断才得到版本拒绝信息。纯协议探针还曾把 deferGoalContinuation 与 ephemeral 同时传入，服务端拒绝此组合。删除冲突参数后，纯协议模式通过；当前临时分支调用不再传递该参数。证据：`tests/live/side-question-probe.mts:136`、`tests/live/side-question-probe.mts:169`。

首轮“真模型受阻”的结论已被本报告第 2 节的新实测更新，但首轮失败记录不是伪造成功或可忽略的错误。
