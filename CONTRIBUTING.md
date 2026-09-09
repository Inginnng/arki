# Contributing to Arki

中文和 English 的 Issue、文档与 PR 都欢迎。Useful contributions include reproducible bugs, clearer explanations, new public example projects, accessibility improvements, and supported-platform validation.

## Before changing code

Search [existing issues](https://github.com/Inginnng/arki/issues). For a substantial new feature, describe the user problem and tradeoffs first. Small fixes can go straight to a pull request. Avoid including private repositories, credentials, conversation history or unsanitized diagnostics.

## Development

Use Node.js 22 LTS, pnpm 10.33, Git and ripgrep. Windows with Microsoft Edge is the currently verified desktop environment; other platforms need additional live Codex validation.

```sh
git clone https://github.com/Inginnng/arki.git
cd arki
pnpm install --frozen-lockfile
pnpm check
pnpm test:e2e
```

`pnpm dev:web` starts the development workspace. `pnpm build` creates the self-contained plugin and production UI; `pnpm start` launches that build. Browser tests use Edge locally; set `ARKI_BROWSER_CHANNEL=chromium` after installing Playwright Chromium to use it in CI. See [development](docs/development.md).

## A useful pull request

Explain the problem, resulting behavior and relevant validation. Add regression coverage for behavior that could break; documentation-only changes need link and content checks, not artificial tests. Preserve unrelated changes and do not include local runtime data. Keep release-facing documentation accurate when behavior changes.

Architecture facts must trace to current code. Static imports must not become invented runtime flows. Invalid layout must not erase a useful analysis. Preserve project boundaries and the exact-diff approval required to create `*.explained.md`; never overwrite source Markdown.

The monorepo boundaries are documented in [AGENTS.md](AGENTS.md) and [architecture](docs/architecture.md). By contributing, you agree that your contributions are available under the project's MIT license, while preserving applicable third-party notices.
