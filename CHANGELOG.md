# Changelog

Release notes describe shipped behavior. Planned features belong in the [roadmap](docs/roadmap.md).

## 0.3.0 — 2026-09-09

First public Arki release.

### Added

- Version panel with manual GitHub release checks, numeric version comparison, request caching, timeout/error states and validated official release links.
- Downloadable, self-contained plugin/workspace ZIP with SHA-256 checksums; Node.js and signed-in Codex remain prerequisites.
- Chinese and English introductions, quickstart, usage, updates, troubleshooting, contribution and security guides.
- CI for type checks, tests, production packaging and browser coverage; a tag-triggered release workflow and issue/PR templates.

### Included from local development

- Separate document and architecture workbenches, source-backed questions, browser persistence and offline reading.
- Nested component architecture with typical scenarios on the same fixed layout; repeated participants, branches, parallel paths, joins, returns and retries.
- Source references, exact-diff reviewed document synthesis, diagnostics, undo/redo and Markdown/HTML exports.
- Fixes for controlled-node edge initialization, scenario button contrast and viewport fitting.

### Limitations

- Windows is the primary validated desktop environment. Broader macOS/Linux live testing is pending.
- Architecture analysis uses project evidence, not verified inheritance of the current Codex task. General model accuracy is not established by fixture tests.
- Updates are checked manually; installation is explicit and documented. No background updater or system startup service is installed.

## 0.2.3–0.2.7 — local development

Architecture semantics, component/flow separation, diagram fallback and typical-scenario reading were developed and validated locally. These were not earlier GitHub releases. Historical implementation details are recorded in [workbench status](docs/inline-reading-status.zh-CN.md).
