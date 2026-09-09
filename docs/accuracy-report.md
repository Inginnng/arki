# AIMD Reader accuracy report

> Status: **provisional / model run not performed**.

Observed on: 2026-09-04

## What was evaluated

tests/accuracy/questions.json defines 20 project questions against the committed tests/fixtures/sample-project fixture. The corpus covers project purpose, architecture, entry points, types, behavior, error handling, call chains, workflow, conflict handling, tests, configuration, dirty state, and five nonexistent-feature traps.

Each question declares atomic facts, required and forbidden entities, allowed file/line evidence, deterministic text checks, refusal expectations, and an empty human-review record. Evidence spans are checked against the current fixture.

## Current results

| Result | Status |
| --- | --- |
| Corpus structure | Passed: exactly 20 unique questions and five refusal traps. |
| Fixture evidence ranges | Passed: every declared path and line range exists. |
| Deterministic validator acceptance | Passed for the controlled reference answers. |
| Adversarial validator rejection | Passed for fabricated citations, missing facts, forbidden entities, and answered refusal traps. |
| Independent-session isolation | Passed: 20 unique session keys are required. |
| Continuity harness shape | Passed: Q02, Q07, and Q10 share one separate continuity session. |
| Real-model run | Not run. |
| Human semantic support review | Incomplete. |
| Model correctness | Not measured. |
| Direct-support percentage | Not measured. |
| Zero-invention trap result | Provisional until the real-model run is reviewed. |

The deterministic scores are named validator_* and retrieval_fixture_* on purpose. They show that the evaluator and fixture behave as designed; they are not a model benchmark and must not be relabeled as answer accuracy.

## Reproduce deterministic checks

~~~powershell
pnpm test:accuracy
~~~

The test suite validates the corpus, evidence locations, scoring behavior, adversarial failure cases, and live-harness session topology.

## Run the live evaluation

The live harness randomizes the 20 independent questions with a recorded seed, gives each question a fresh session, then runs the three-question continuity subset in a single separate session. It records sanitized model, CLI, fixture, order, and deterministic-validator metadata. It always emits a provisional publication block until human adjudication is supplied.

~~~powershell
$env:AIMD_LIVE_ACCURACY = "1"
$env:AIMD_LIVE_ACCURACY_ADAPTER = "path\to\trusted-adapter.mjs"
$env:AIMD_ACCURACY_SEED = "20260904"
pnpm test:accuracy:live
~~~

The adapter must export createLiveAccuracyRunner. It is responsible for invoking the intended Codex model through a verified project/context path and returning the answer text plus issued evidence references. Without explicit opt-in and a trusted adapter, the command exits safely with not_run.

## Publication rule

Do not publish a correctness percentage from regex checks alone. For every live answer, a reviewer must decide whether each atomic fact is supported by the cited span, whether the answer adds unsupported meaning, and whether required refusal traps remain unanswered. Only then may the report calculate:

- question-level correctness;
- atomic-fact recall;
- direct-support percentage;
- refusal precision for nonexistent features;
- independent-versus-continuity deltas.

The repository currently makes no numerical model-quality claim.
