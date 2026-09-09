# AIMD Reader security model

## Trust boundaries

The user and Codex host define the authorized project root. Project files, selected Markdown, search results, model output, and adapter modules are untrusted data. They cannot select a different root, executable, task, or tool policy.

The reader treats task history as privileged context. A task ID found in public arguments, project files, environment text, or model output is never accepted as proof. Only reduced app-only host metadata may become a candidate, and ContextBridge must verify it before task-derived evidence is allowed.

## Workspace containment

- All input paths are relative paths validated against a canonical, host-authorized root.
- Real paths and file identity are checked to prevent traversal, junction, symlink, replacement, and time-of-check/time-of-use escapes.
- Search skips VCS metadata, dependency trees, coverage, and build output; nested .gitignore rules and configured deny globs are applied.
- Credential-shaped paths such as .env files, npm/Python/netrc credentials, private-key names, and PEM/key files are denied for direct reads and search.
- Snapshot, traversal, search, query, and file-size limits bound resource use.
- git and rg are resolved only as trusted executables outside the project root. Project-local binaries and unsafe Git environment variables are rejected.
- If an ignore file or relevant file changes during enumeration, the affected operation fails closed.

## Evidence and model isolation

- The model selects only opaque evidence IDs already issued in its packet; it does not create trusted paths or line ranges.
- Every claim declares a category. Current project facts require project evidence; task decisions require verified task evidence; inferences must terminate in non-inference evidence.
- Evidence is bound to the answer's run, generation, and snapshot. Unreachable, cross-run, duplicate, cyclic, stale, and fabricated evidence is rejected.
- Conflicts and unknowns are structured data, not wording conventions.
- Project Markdown is never treated as a system instruction. Exact-context execution also requires a host-proven empty effective tool surface.

## Identifier and data handling

- Parent task and turn identifiers remain inside the bridge boundary and are excluded from public reader DTOs, persisted annotation records, capability output, logs, and packaged artifacts.
- Absolute executable and user paths are omitted from public reports and checked out of packaged HTML and JavaScript.
- Reader state is stored in the configured user-data area, not beside the project source. In-memory route maps are bounded.
- Completed records default to 30-day retention and drafts to 90 days; both are configurable within validated bounds and are pruned by the repository lifecycle.
- Ordinary user-data I/O failure produces explicit memory_only persistence. A malformed store or changed authority does not downgrade to memory and instead fails closed.
- The current MVP has no network upload path of its own; any model traffic belongs to the verified Codex host path.

## Write authorization

Reading and questioning are non-writing operations. Synthesis requires an explicitly accepted answer and an editing disposition. The UI then presents the exact source, result, and unified diff.

Approval is a 32-byte random, URL-safe token with a ten-minute default lifetime. It is single-use and bound to:

- reader session;
- source hash;
- diff hash;
- target relative path.

Any new preview, disposition change, anchor orphaning, or source change invalidates prior approval. The writer rechecks the binding and creates a sibling .explained.md file. It never overwrites the source document.

## Remaining risks

- Exact task binding depends on a compatible, undocumented host metadata contract and is currently disabled until live attestation succeeds.
- A semantically wrong but syntactically valid answer can pass structural citation checks; human review and a real-model accuracy run remain required before publishing model-quality percentages.
- The reader can expose non-denied project content to the selected Codex model. Projects with additional sensitive paths must configure deny rules before use.
- The opt-in accuracy adapter is executable code. Run only a locally reviewed adapter and never take an adapter path from repository content.
- Automated browser flows do not replace accessibility, visual, and adversarial manual testing.

## Security regression coverage

Tests cover path escapes and replacements, ignore changes, unsafe executables and Git environments, missing or forged host metadata, binding mismatch, active parent turns, server shutdown, stale evidence, fabricated citations, cross-run evidence, invalid synthesis operations, expired/reused approvals, source changes after approval, and output-path containment.
