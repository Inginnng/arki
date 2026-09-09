# 网页侧边问答：实现与验收状态

> 本文保留上一轮后端验收记录，其中 SideQuestionPanel 为旧网页界面。2026-09-05 后续已改为正文内胶囊；当前 UI、记录生命周期及最新测试见[段落内阅读状态](inline-reading-status.zh-CN.md)。以下历史计数不代表后续版本的最终计数。

更新日期：2026-09-05。

## 当前结论

中文网页已接入独立的只读侧边问答代码路径：明确选任务、选中 Markdown、提问、展示概念与项目证据。它不是桌面当前任务自动绑定，也不是直接调用交互式 `/btw` 命令。入口证据：`apps/reader-ui/src/App.tsx:483`、`apps/reader-ui/src/SideQuestionPanel.tsx:70`；运行入口：`packages/app-server-bridge/src/local-side-runtime.ts:297`。

**这条新网页链路尚未完成真实项目模型端到端验收。** 本次受控验收命令被安全审核拒绝，因为它会将真实项目选区和代码片段经现有本地 Codex／代理发送到模型服务；已请求用户明确许可，没有重试或绕过。验收脚本：`tests/live/web-side-acceptance.mts:1`。此前两个真实可行性探针样例的成功不能代替这次网页验收，见[此前实测报告](side-question-test-report.zh-CN.md)。

## 你会怎样使用

1. 启动本地网页服务，打开 `/web.html`。服务组装真实运行时与 `/api/side`，不是生产环境的固定问答模板：`scripts/start-web.mts:63`、`scripts/start-web.mts:101`。
2. 在中文侧栏明确选择当前项目的一项 Codex 任务。浏览器只拿到不透明句柄，服务端重新核对项目与任务；不会根据最近访问记录猜测桌面当前任务：`apps/reader-ui/src/SideQuestionPanel.tsx:87`、`packages/app-server-bridge/src/local-side-runtime.ts:149`、`packages/app-server-bridge/src/local-side-runtime.ts:187`。
3. 在文档中拖选词句，输入问题并提交。提交的是实际选区偏移、文档哈希和问题：`apps/reader-ui/src/SideQuestionPanel.tsx:70`、`packages/contracts/src/side-question.ts:7`。
4. 回答分为概念说明、当前项目证据、所选任务讨论、未知与限制。可以点击文件及行号查看来源；它只标注引用核验，不标注独立语义审核通过：`apps/reader-ui/src/SideQuestionPanel.tsx:109`。

## 实际实现方式

- **任务上下文：** 在选择时固定已完成讨论的截止点，保留有限的用户／助手文本，再按本次问题选择相关片段。并非完整复制全部任务历史，也不连续向主任务追加问题。代码：`packages/app-server-bridge/src/local-side-runtime.ts:187`、`packages/app-server-bridge/src/local-side-runtime.ts:297`。
- **代码证据：** 先校验浏览器文档哈希，再读取选区附近内容并做有界字面检索；最多 4 个检索词、8 份证据。超出预算或无法检索时明确标记范围不完整，不声称覆盖整个项目。代码：`packages/workspace-server/src/side-question-service.ts:22`、`packages/workspace-server/src/side-question-service.ts:34`、`packages/workspace-server/src/side-question-service.ts:47`。
- **真实模型调用：** 本地 App Server 新建 ephemeral 临时任务，传入相关讨论、问题和当前证据，通过 `turn/start` 获取模型 JSON；默认模型沿用运行时配置。没有固定答案兜底。代码：`packages/app-server-bridge/src/local-side-runtime.ts:326`、`packages/app-server-bridge/src/local-side-runtime.ts:370`。
- **结果校验：** 严格解析回答结构，拒绝未签发的引用编号，回答后重新检查全部证据和原始文档哈希。引用存在并不证明每句话语义正确。代码：`packages/contracts/src/side-question.ts:12`、`packages/workspace-server/src/side-question-service.ts:67`、`packages/workspace-server/src/side-question-service.ts:77`。
- **取消和切换：** 取消提问、切换任务、开始加载文档会中止客户端请求并忽略晚到结果；服务端将断连传播给模型运行。代码：`apps/reader-ui/src/SideQuestionPanel.tsx:45`、`apps/reader-ui/src/SideQuestionPanel.tsx:58`、`apps/reader-ui/src/App.tsx:483`、`packages/workspace-server/src/side-question-api.ts:29`。

## 验证记录

- 新增回归已复现并修复：取选区和取证之间的文档变更、导航开始时未及时取消、丢弃检索词却未提示。测试：`packages/workspace-server/src/side-question-service.test.ts:36`、`apps/reader-ui/src/App.test.tsx:12`。
- 取消、导航、切换任务后的晚到回答均有组件测试：`apps/reader-ui/src/SideQuestionPanel.test.tsx:7`。
- 独立代码规格和代码质量复审均通过；这不代替真实模型验收。
- 修复模型 commentary 与最终 JSON 混合、长历史全量响应超限及 CR-only 行号错误。长历史改用摘要分页（最多 32 页、24K 文本），单条摘要仍受 1 MiB 通信上限限制。测试：`packages/app-server-bridge/src/local-side-runtime.test.ts:218`、`packages/app-server-bridge/src/local-side-runtime.test.ts:224`、`packages/workspace-server/src/side-question-service.test.ts:26`。
- `pnpm test:e2e`：6 项通过，包括新侧聊网页的选区传参、任务选择、答案分区与窄屏布局。这些仍是明确的离线夹具，不是新网页真实模型验收。测试入口：`playwright.config.ts:5`、`tests/e2e/reader.spec.ts:3`、`tests/e2e/side-question.spec.ts:1`。
- 最终 `pnpm check` 于本轮实测以退出码 0 完成：51 个测试文件、931 项测试全部通过，类型检查和自包含插件构建通过。此前打包产物／报告生成器不同步的失败已修复，没有移除一致性断言。命令入口：`package.json:17`。
- 本次 5180 开发服务器已重启，`/api/health` 返回 ok、`/web.html` 返回 HTTP 200；这仅证明服务和页面可访问，不证明模型问答成功。可打开 [本地网页](http://127.0.0.1:5180/web.html)。服务入口：`scripts/start-web.mts:63`。

## 明确尚未实现或未证明

- 桌面当前任务的可信宿主自动绑定：仍未得到宿主支持；状态权威见[能力报告](capability-report.md)。
- 新侧聊流程的独立语义审核、审批写入和持久化多轮侧聊：尚未接入，页面当前仅保存本次结果。界面限制：`apps/reader-ui/src/SideQuestionPanel.tsx:117`。
- 严格工具隔离：请求了无工具、只读配置，并监控意外工具事件，但这不是宿主隔离证明。配置与运行：`packages/app-server-bridge/src/local-side-runtime.ts:42`、`packages/app-server-bridge/src/local-side-runtime.ts:326`。
- 通用问答准确率、长历史检索覆盖率、多人并发与其他 Agent：没有因本轮局部测试而获得验收。

下一步是取得本次真实项目片段发送许可后，执行网页受控验收，核对回答质量、任务讨论、引用跳转、移动端展示及源文件不变；如果真实调用失败，就继续定位实际错误，不用模板答案替代。
