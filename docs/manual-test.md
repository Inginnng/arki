# AIMD Reader manual release checklist

Use a disposable project copy. Do not test write behavior against valuable documentation until the preview and containment steps pass.

## 1. Build and install

1. Run pnpm install --frozen-lockfile, pnpm check, pnpm test:e2e, and pnpm test:accuracy.
2. Confirm plugins/aimd-reader/dist contains server.mjs, reader.html, probe.html, and the Windows safe-write helper.
3. Enable aimd-reader@aimd-local from .agents/plugins/marketplace.json.
4. Fully restart Codex desktop. Open a new task rooted at the test project; an already-running task cannot retroactively provide plugin startup metadata.

Expected: the plugin loads without external node_modules at runtime and exposes the AIMD reader resource.

## 2. Verify context mode

1. Open the reader and inspect the context badge before asking a question.
2. For an exact-context release test, use tests/live/fixtures/dirty-project, make the documented uncommitted sentinel edit, and run the app-only capability probe.
3. Confirm task + project mode appears only if the probe verifies the exact task, the dirty workspace sentinel, the isolated side session, and its empty tool surface.
4. If any gate fails, confirm the UI says project evidence only or document context only and explains why.
5. Ask about a decision that exists only in the parent task. In degraded modes, the reader must refuse or label it unknown rather than infer it.

Do not accept a public task ID, matching title, project path, or plausible answer as proof of exact context.

## 3. Read and ask

1. Open a Markdown document containing headings, paragraphs, inline code, a list, and a code fence.
2. Select text with the mouse, then repeat using only the keyboard.
3. Ask two different questions on the same selection.
4. Confirm the main Codex task transcript is not appended with those reader questions.
5. Inspect every evidence chip and open each source excerpt.

Expected: selection maps to exact source offsets; questions remain grouped at the anchor; answers distinguish project facts, document statements, task decisions, and inference; code claims show current relative paths and line ranges.

## 4. Accuracy failures

1. Ask for a nonexistent module, API, database, or queue.
2. Change a cited source file while an answer is running or after it completes.
3. Change the Markdown around a saved anchor so it cannot be relocated safely.
4. Present two files that disagree with each other or with the document.

Expected: nonexistent claims are refused; dirty evidence is stale and cannot be persisted; failed relocation is orphaned; conflicts show both sides. No case should silently invent or choose an answer.

## 5. Synthesis and safe write

1. Leave one accepted answer as reading-only and confirm it is excluded.
2. Set another to Inline, Replace, Glossary, or FAQ.
3. Prepare the explained document and compare 原文, 生成结果, and 统一差异.
4. Confirm no file is written before approval.
5. Approve the exact diff, then modify the source before clicking Write.
6. Confirm the write is rejected and no output appears.
7. Prepare and approve again without modifying the source, then write.

Expected: the only new file is the sibling *.explained.md; the source bytes are unchanged. Approval cannot be reused.

## 6. UI and accessibility

Test at 1280×800 and 1600×1000, light and dark appearance, 200% zoom, long paths, long answers, and narrow panes. Check:

- visible keyboard focus and logical tab order;
- readable status text without relying only on color;
- selection toolbar placement;
- source excerpt scrolling and line-number alignment;
- no overlap or clipped controls;
- 原文/生成结果/统一差异 content remains distinguishable;
- no browser console errors.

Open docs/architecture/aimd-reader-architecture.html and visually inspect every node and connector at overview and detail zoom. This step remains pending on the current development machine because automated screen capture inspection failed even though artifact validation passed.

## 7. Record the release evidence

Record Codex desktop and CLI versions, operating system, fixture commit, context gate result, test command outputs, screenshots, reviewer, and date. Publish model accuracy or direct-support percentages only after the opt-in live harness has run against a named model and each answer has completed human support review.
