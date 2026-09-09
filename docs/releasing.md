# 发布指南

只有维护者推送 `v*` 标签或手动运行 release workflow 会创建发行版。Pull request 只运行检查，不发布。

## 准备

1. 更新 `packages/contracts/src/release.ts`、根 `package.json` 与 `plugins/aimd-reader/.codex-plugin/plugin.json` 的版本号。
2. 在 `CHANGELOG.md` 和 `docs/releases/v<version>.md` 写清变化、兼容性、验证与限制。
3. 运行 `pnpm check`、`pnpm test:e2e`、`pnpm check:release`。
4. 运行 `pnpm release:pack`，在 `release/` 检查 ZIP、manifest 和 SHA-256。解压验证启动器及隐藏的插件元数据都存在。
5. 提交源代码、文档和自包含 `plugins/aimd-reader/dist`。不要提交临时目录、日志、用户代码或真实对话。

## 发布

确认主分支 CI 通过，再给对应提交打标签：

```sh
git tag v0.3.0
git push origin v0.3.0
```

Release workflow 会检出标签、检查版本一致性、重建并验证发行包，然后发布 GitHub Release，附带 ZIP、`SHA256SUMS.txt` 和 `release-manifest.json`。正式发布只接受 `v<major>.<minor>.<patch>`；RC 等预发布需要单独设计渠道，当前工作台只检查正式版。

也可在 Actions 里手动选择已存在的标签，重试失败的发布。已发布版本不可覆盖；修复应递增版本号。发行说明使用对应的 `docs/releases/v<version>.md`，避免把内部提交记录直接当成用户说明。

## 验收

- 下载链接和校验文件能访问，版本与标签一致。
- 解压包包含 `.codex-plugin/plugin.json`、`.mcp.json`、`dist/arki.mjs`、`dist/web-server.mjs`、`dist/web/web.html` 和第三方许可。
- 从公开仓库克隆可构建；不依赖维护者本机绝对路径或未跟踪文件。
- 工作台「检查更新」能读取当前 Release；断网不误报“已是最新版”。

版本发现使用 [GitHub 官方 Releases API](https://docs.github.com/en/rest/releases/releases)。发布工作流只授予所需的 `contents: write`，不向 fork PR 暴露发布令牌。
