# Arki architecture

## Local architecture workspace

The primary Arki entry is `scripts/arki.mjs`, a project-aware launcher and bounded background supervisor. `scripts/start-web.mts` binds the production server to loopback and serves the web workspace. `apps/reader-ui/src/Workbench.tsx` separates document reading from architecture exploration.

`architecture-service.ts` discovers bounded project evidence, asks Codex for additional relevant implementation excerpts, then synthesizes components, boundaries and typical scenarios. Strict contracts and source hashes validate returned references; the model does not author layout coordinates. `ArchitectureDiagram.tsx` uses ELK for shared component geometry and React Flow for selection, with scenario routes over the same positions. Step IDs are independent of component IDs so a request can revisit a component.

Browser stores preserve completed analyses and answers per project and origin. The service worker caches only the application shell. The update API reads a fixed public GitHub release endpoint on demand and returns constrained metadata; it has no filesystem write or model authority.

The sections below describe the separately retained evidence-review and safe-document-synthesis path. Its original interactive diagram predates the full workbench and is a compatibility/design artifact.

The architecture separates three trust decisions: whether a task binding is authentic, whether a project claim is supported by current files, and whether an accepted explanation is authorized to become a file edit. None of those decisions is delegated to the UI or to free-form model text.

Open the [interactive architecture diagram](architecture/aimd-reader-architecture.html) or inspect its [validated source specification](architecture/aimd-reader-architecture.json). The diagram passed schema and artifact validation; automated visual inspection did not complete on this Windows host, so visual review remains pending.

## Runtime path

1. The self-contained React reader sends only allowlisted calls through its MCP Apps host adapter.
2. The reader MCP service resolves a host-authorized workspace root and creates a bounded per-root runtime.
3. HostContextExtractor reduces app-only host metadata to a candidate. ContextBridge verifies it with the generated Codex App Server client before task history is eligible.
4. The workspace layer reads current files through canonical-path, ignore-rule, byte-limit, and snapshot guards.
5. The answering boundary receives issued evidence packets, not arbitrary file authority. Returned claims can cite only opaque evidence IDs issued for that run and generation.
6. Contract validation checks claim categories, provenance, snapshot digests, line ranges, inference grounding, conflicts, and support-review records.
7. Only evidence-reviewed answers may become synthesis inputs. A user-selected disposition determines the permitted edit operation.
8. The service prepares a deterministic preview. A separate approval binds the session, source hash, diff hash, and target path.
9. The safe writer rechecks the source and writes a sibling .explained.md file.

## Components

| Component | Responsibility |
| --- | --- |
| apps/reader-ui | Exact selection, question lifecycle, evidence inspection, dispositions, preview, approval, and write UI. |
| packages/contracts | Strict schemas for sessions, packets, evidence, claims, answers, reviews, previews, and tool payloads. |
| packages/app-server-bridge | Generated protocol client, host binding verification, isolated side-task lifecycle, and fail-closed status. |
| packages/reader-core | Markdown anchors, relocation, citation/support review, edit-intent validation, diff construction, and approval authority. |
| packages/workspace-server | Authorized-root resolution, safe read/search/snapshot, annotation storage, production orchestration, MCP server, and safe output. |

## Context fidelity

The desired path is an isolated side question derived from the exact current Codex task, giving the answering model both task decisions and live project evidence without writing the exchange into the main transcript. That path is enabled only after the desktop host supplies trusted metadata, the binding is verified, an isolated model session is created, and the effective tool surface is known to be empty.

If any prerequisite fails, the session advertises either project-only or document-only context. Contracts then reject task-decision evidence in project-only answers and reject evidence outside the selected document in document-only answers. This makes degradation observable and machine-enforced.

## Evidence freshness

Evidence is bound to a snapshot digest, run ID, generation, file hash, path, and line range. Before display, persistence, synthesis, and final write, the service rechecks the relevant bindings. A changed file marks the answer stale; a failed anchor relocation becomes orphaned rather than being guessed into a new location.

## Storage boundary

Reader records live outside the project by default and are routed by a derived root identity. Public DTOs contain relative project paths and opaque reader IDs, not the parent task ID. Generated output is the only intentional project write and occurs only after exact-diff approval.
