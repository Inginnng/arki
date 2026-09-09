# AIMD live context fixture

This tiny project is a controlled root for the opt-in Codex desktop capability probe.
It is not a production example and contains no user project data.

Before invoking the app-only probe in a newly restarted Codex task, change
`LIVE_DIRTY_SENTINEL` in `src/architecture.ts` from `committed-baseline` to
`AIMD-DIRTY-CONTEXT-LIVE-v1`. Keep that edit in the working tree and **do not commit** it.
The live probe must find the changed value from supplied project evidence while leaving
this parent task and the fixture bytes unchanged.

The checked-in baseline intentionally does not contain the live sentinel in source code,
so a passing result cannot come from committed context alone.
