# AIMD capability report

> Current result: **degraded**. The packaged reader and project-grounded local pipeline are verified, but live exact-task context remains unsupported until a Codex desktop task supplies trusted app-only host metadata.

Observed on: 2026-09-04

## Arki · 一览 workspace — 2026-09-08

Arki adds one-click project analysis, synchronized architecture Markdown and diagrams, whole-architecture questions and selectable typical scenarios, and per-project restoration of the last 20 completed architecture answers with evidence excerpts. The production launcher reuses the same project backend or starts an independent local process with bounded crash recovery. The production application shell and rendered diagram support offline reopening after a successful first load; current source inspection and AI still require the backend. Reconnection refreshes server-issued root IDs, and architecture requests verify a project digest. This does not enable exact desktop-task inheritance or claim complete codebase coverage. See [current verification](inline-reading-status.zh-CN.md).

## Local web workbenches — 2026-09-07

The local architecture workbench uses React Flow with ELK layout. The component view represents evidence-backed subsystem containment, including nested groups; the flow view overlays selectable evidenced scenarios on the same component positions. Independent steps preserve repeated participants, conditions, parallel branches, joins, returns and retries. Invalid scenario references are isolated with diagnostics, while geometry failures retain readable component and transfer directories. Transfers carry payload, mechanism, receiver processing and result. Whole-project analysis performs a bounded AI reading-plan pass, reads the selected implementations through guarded workspace APIs, and then authors a fresh graph independently of the package/import seed. Citation IDs are constrained to the current evidence set during generation. Component, subsystem and relationship selection, code inspection, edits, undo/redo, browser persistence, offline reopening, themes and standalone two-view HTML export are implemented. Existing records remain readable and offer explicit re-analysis. Architecture open, analysis, edits and explanations return validated graph data without requiring an Archify artifact. Legacy rendering is optional in saved views; only the explicit compatibility export calls Archify. Its receipts do not validate the React Flow canvas. No architecture action writes project sources or inherits the desktop task.

Architecture service regressions cover selected-object updates, connected additions, source changes, unissued evidence, path traversal, cancellation and successful graph operations despite legacy composition failures. Browser coverage exercises actual React Flow/ELK rendering with explicit model fixtures; compatibility tests retain Archify coverage. Two controlled live Codex samples succeeded on reader-ui: one refined the selected rectangle; the other added a React-mount node and its relationship from code evidence, preserving all existing objects. The second sample also passed browser undo, redo, reload and standalone HTML export. These establish functional live samples, not general model accuracy or complete architecture coverage. Explicit legacy Archify exports retain nine checks with zero errors and warnings; those checks do not gate the workbench or its ELK HTML export. The component and scenario views have distinct semantics with identical component geometry. Every scenario, step and transition remains available in the reader, document and offline export. New scenarios do not depend on the legacy acyclic narrative or Archify checks. A controlled public synthetic run generated three scenarios with repeated participants in two model calls; this is a functional sample, not coverage or general accuracy certification. Model evidence is balanced across module implementations (up to 24 excerpts); static dependencies remain distinct from calls/data transfers. Exact desktop task binding and the existing packaged capability flags below remain unchanged. Current run results are recorded in [workbench verification](inline-reading-status.zh-CN.md).

## Separate local web side questions — 2026-09-05

Two controlled live feasibility samples passed with Codex CLI 0.153.3; they are not an end-to-end web acceptance. The Chinese web entry now has explicit task selection and a read-only selected-discussion question path in source code. Real-project model acceptance is pending data-transmission permission. See [Chinese implementation status](web-side-question-status.zh-CN.md) and [live feasibility report](side-question-test-report.zh-CN.md).

This separate mode does not enable the packaged feature flags below, establish exact desktop-task binding or strict tool isolation, or provide independent semantic review, durable side-chat history, or reviewed document writes. The version and gate sections below retain the earlier packaged-probe observations, not the current installed runtime inventory.

## Version facts

- Generated schema CLI: `codex.exe` `0.151.0-alpha.7.2` (path redacted).
- Desktop/host compatibility: `0.151.0-alpha.7.2` — `matched`.
- PATH CLI compatibility: `0.152.0` — `mismatch`.
- The generated protocol came from the desktop-matched CLI. The newer PATH CLI was not substituted for it.

## Read-only executable preflight

- Source: `direct_executable_lookup` (executable path omitted).
- Status: `version_mismatch`.
- Observed version: `0.153.0-alpha.5`.
- App Server surface: `available`.
- This preflight runs only version and App Server help commands; it cannot upgrade a live gate.

## Gate results

| Gate | Status | Sanitized evidence |
| --- | --- | --- |
| P0-A | inconclusive | The packaged resource, fullscreen request, and app-only tool path passed deterministic MCP and browser tests; this is not live desktop attestation. |
| P0-B | unsupported | The current task did not expose trusted raw CallTool metadata to the app-only probe, so exact task binding was not claimed. |
| P0-C | unsupported | An exact ephemeral fork cannot be proven without the trusted binding required by P0-B. |
| P0-D | unsupported | The local two-citation reader pipeline passed, but no live side question was started without host-proven isolation and exact metadata. |
| P0-E | passed | Deterministic regressions fail closed for missing metadata, binding mismatch, active turns, root replacement, version mismatch, server shutdown, stale evidence, and fabricated citations. |

P0-A's deterministic transport and browser results are supporting evidence only; they are not a live desktop pass and cannot enable `reader_only`. P0-B through P0-D are explicitly unsupported in the current task. P0-E records deterministic fail-closed regression coverage, not a substitute for live context fidelity.

## Feature flags

- task_and_project: `false`
- project_only: `false`
- reader_only: `false`

## Enforced safety boundary

- No real hidden host metadata was available to this already-running task.
- The updater accepts no public task identifier or workspace path.
- It performs no task discovery and uses no current-directory fallback.
- It starts no model turn because the host has not proven an empty effective tool surface.
- It stores no task or turn identifiers and emits no absolute executable path.

## Locally verified implementation

- The production plugin contains one self-contained reader resource and one bundled server resource, with no runtime node_modules dependency.
- The filesystem-backed service flow validates two current code citations, persists only reviewed answers, requires an explicit disposition, previews an exact diff, and writes a sibling explained document without overwriting its source.
- Browser smoke tests complete the keyboard question, source peek, disposition, diff approval, and write-success path at 1280 by 800 and 1600 by 1000 with no browser console errors.
- The 20-question deterministic accuracy corpus validates fixture coverage, citation and refusal checks, unique independent-run session keys, and shared continuity-session topology. It does not measure real-model correctness or prove real Codex task or process isolation.
- Browser screenshots were captured, but direct image inspection in this host was blocked by the Windows CUA kernel asset-path failure; this remains an explicit manual visual-review item.

## Isolated adapter boundary

- Hidden host metadata is reduced only by HostContextExtractor, then verified through ContextBridge and the generated App Server client. If the host metadata contract changes, this adapter boundary is the only component that should require protocol-specific changes.

## Initial Phase 0 history

On 2026-09-02, P0-A was inconclusive and P0-B through P0-E were not_run because the plugin was not present at task start. No reader or context feature flag was enabled. This history is retained; the Task 10 evidence above does not rewrite it.

## Recovery checklist

1. Completed: package the local plugin and enable `aimd-reader@aimd-local` from its personal marketplace entry.
2. Restart Codex desktop so the plugin is present when the next task starts.
3. Open a new task with `tests/live/fixtures/dirty-project` as the exact project root.
4. Make the fixture's documented uncommitted sentinel edit, then invoke the app-only probe.
5. Rerun this sanitized updater and review the new gate evidence before enabling context modes.

Until those steps succeed, the packaged capability probe must keep exact task context disabled and present project-only degradation honestly.

> Public distribution: Arki 0.3.0 adds a manual GitHub version check and portable release packaging. Update metadata does not include project content; checks do not install or restart software. See [release notes](releases/v0.3.0.md). These distribution features do not change the task-binding or model-accuracy limits above.
