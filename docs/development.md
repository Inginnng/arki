# 开发与测试

## 工作区

TypeScript monorepo：React/Vite UI、Zod 契约、Codex bridge、纯逻辑 reader core 和授权文件访问 workspace server。生产工作台使用 React Flow + ELK，历史兼容导出仍有独立 Archify 运行时。

| 命令 | 用途 |
| --- | --- |
| `pnpm install --frozen-lockfile` | 安装锁定依赖 |
| `pnpm dev:web` | 开发工作台，支持热更新 |
| `pnpm typecheck` | 全工作区类型检查 |
| `pnpm test` | 单元、集成与确定性准确性测试 |
| `pnpm test:e2e` | 两种桌面尺寸的浏览器回归 |
| `pnpm build` | 构建自包含插件与生产工作台 |
| `pnpm check` | 类型检查、测试、生产构建 |
| `pnpm check:release` | 版本一致性、公共文档链接和发行输入检查 |
| `pnpm release:pack` | 创建可下载 ZIP 和校验文件，需先构建 |

## 浏览器测试

本地默认使用已安装的 Microsoft Edge。CI 使用 Playwright Chromium：

```sh
pnpm exec playwright install chromium
```

PowerShell：`$env:ARKI_BROWSER_CHANNEL="chromium"`；POSIX shell：`export ARKI_BROWSER_CHANNEL=chromium`，然后 `pnpm test:e2e`。测试会自己启动 4173 端口的开发服务，API 使用公开夹具，不运行真实 Codex。

## AI 验证边界

普通 `pnpm check` / CI 不需要登录 Codex。真实模型验证需要显式配置和人工检查，可能消耗账号额度；不要让 fork PR 自动调用个人凭据或真实模型。`pnpm test:accuracy` 是确定性规则验证，不是模型排行榜。详见 [准确性报告](accuracy-report.md)。

## 本地数据

`.tmp/`、浏览器存储、系统临时目录中的后台记录和日志、凭据及依赖目录不纳入发布。源码夹具使用公开虚构数据。`.aimd-git/` 是历史本地开发元数据，首个公开仓库使用独立、常规的 `.git/`。
