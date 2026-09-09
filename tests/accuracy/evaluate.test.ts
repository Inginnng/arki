import { describe, expect, it } from "vitest";

import {
  assertCorpusEvidenceExists,
  loadAccuracyCorpus,
  scoreAccuracyRun,
  type AccuracyAnswer,
  type AccuracyCorpus,
} from "./rubric.js";
import { runLiveAccuracyEvaluation, type LiveAccuracyRequest } from "./live-evaluate.js";

function deterministicFixtureAnswers(corpus: AccuracyCorpus): AccuracyAnswer[] {
  return corpus.questions.map((question) => ({
    questionId: question.id,
    outcome: question.refusalExpectation.required ? "refused" : "answered",
    text: question.refusalExpectation.required
      ? `${question.atomicFacts.map(({ statement }) => statement).join(" ")} No evidence was found; it is not implemented or present and cannot be verified.`
      : `${question.atomicFacts.map(({ statement }) => statement).join(" ")} ${question.requiredEntities.join(" ")}`,
    factIds: question.atomicFacts.map(({ id }) => id),
    citations: question.refusalExpectation.required ? [] : question.allowedEvidence,
    snapshotDigest: "fixture-snapshot",
    sessionKey: `isolated-${question.id}`,
  }));
}

describe("accuracy rubric and deterministic enforcement", () => {
  it("defines exactly twenty unique questions including five invention traps", async () => {
    const corpus = await loadAccuracyCorpus();
    expect(corpus.questions).toHaveLength(20);
    expect(corpus.questions.filter(({ category }) => category === "nonexistent_trap")).toHaveLength(5);
    expect(new Set(corpus.questions.flatMap(({ atomicFacts }) => atomicFacts.map(({ id }) => id))).size)
      .toBe(corpus.questions.flatMap(({ atomicFacts }) => atomicFacts).length);
    expect(corpus.questions.every(({ humanReview }) => humanReview.supported === null && humanReview.reviewer === null)).toBe(true);
    await expect(assertCorpusEvidenceExists(corpus)).resolves.toBeUndefined();
  });

  it("scores validator and retrieval-fixture metrics without calling them model accuracy", async () => {
    const corpus = await loadAccuracyCorpus();
    const result = scoreAccuracyRun(corpus, deterministicFixtureAnswers(corpus));
    expect(result.metrics).toMatchObject({
      validator_contract_rate: 1,
      validator_fact_id_rate: 1,
      validator_refusal_alignment_rate: 1,
      validator_entity_check_rate: 1,
      validator_citation_boundary_rate: 1,
      validator_deterministic_check_rate: 1,
      retrieval_fixture_question_coverage: 1,
      retrieval_fixture_span_coverage: 1,
      validator_zero_invention_trap_rate: 1,
      model_correctness: "not_measured",
      semantic_support: "needs_human_review",
    });
    expect(Object.keys(result.metrics).every((name) => name.startsWith("validator_") || name.startsWith("retrieval_fixture_") || ["model_correctness", "semantic_support"].includes(name))).toBe(true);
  });

  it("rejects fabricated citations, missing facts, forbidden entities, and answered traps", async () => {
    const corpus = await loadAccuracyCorpus();
    const answers = deterministicFixtureAnswers(corpus);
    const architectureIndex = answers.findIndex(({ questionId }) => questionId === "Q02");
    const trapIndex = answers.findIndex(({ questionId }) => questionId === "Q16");
    answers[architectureIndex] = {
      ...answers[architectureIndex]!,
      text: "A message broker connects gateway and worker.",
      factIds: ["F02A"],
      citations: [{ path: "src/nonexistent.ts", startLine: 1, endLine: 9 }],
    };
    answers[trapIndex] = {
      ...answers[trapIndex]!,
      outcome: "answered",
      text: "src/router.ts uses a dispatch table.",
      citations: [{ path: "src/router.ts", startLine: 1, endLine: 2 }],
    };

    const result = scoreAccuracyRun(corpus, answers);
    expect(result.scores.find(({ questionId }) => questionId === "Q02")).toMatchObject({
      factIdsValid: false,
      entityChecksValid: false,
      citationsValid: false,
    });
    expect(result.scores.find(({ questionId }) => questionId === "Q16")).toMatchObject({
      refusalAligned: false,
      citationsValid: false,
      zeroInventionTrapPassed: false,
    });
    expect(result.metrics.validator_zero_invention_trap_rate).toBeLessThan(1);
    expect(result.metrics.model_correctness).toBe("not_measured");
  });

  it("requires isolated sessions for the twenty-question independent run", async () => {
    const corpus = await loadAccuracyCorpus();
    const answers = deterministicFixtureAnswers(corpus);
    expect(new Set(answers.map(({ sessionKey }) => sessionKey)).size).toBe(20);
  });

  it("keeps real-model independent and continuity runs separate and provisional", async () => {
    const requests: LiveAccuracyRequest[] = [];
    let closed = false;
    const corpus = await loadAccuracyCorpus();
    const byId = new Map(deterministicFixtureAnswers(corpus).map((answer) => [answer.questionId, answer]));
    const report = await runLiveAccuracyEvaluation({
      seed: 42,
      observedOn: "2026-09-04",
      runner: {
        metadata: async () => ({ model: "fixture-model", cliVersion: "0.0-test", fixtureCommit: "abc1234" }),
        answer: async (request) => {
          requests.push(request);
          return { ...byId.get(request.question.id)!, sessionKey: request.sessionKey };
        },
        close: async () => { closed = true; },
      },
    });

    const independent = requests.filter(({ mode }) => mode === "independent");
    const continuity = requests.filter(({ mode }) => mode === "continuity");
    expect(independent).toHaveLength(20);
    expect(new Set(independent.map(({ sessionKey }) => sessionKey)).size).toBe(20);
    expect(continuity).toHaveLength(3);
    expect(new Set(continuity.map(({ sessionKey }) => sessionKey)).size).toBe(1);
    expect(report.status).toBe("provisional");
    expect(report.publication).toEqual({
      modelCorrectness: "not measured",
      directSupportPercentage: "not measured",
      humanAdjudication: "incomplete",
      zeroInventionTrapResult: "provisional",
    });
    expect(report.independent.metrics.model_correctness).toBe("not_measured");
    expect(closed).toBe(true);
  });
});
