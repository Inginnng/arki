import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export type EvidenceSpan = Readonly<{ path: string; startLine: number; endLine: number }>;
export type AccuracyQuestion = Readonly<{
  id: string;
  category: string;
  prompt: string;
  atomicFacts: readonly Readonly<{ id: string; statement: string }>[];
  requiredEntities: readonly string[];
  forbiddenEntities: readonly string[];
  allowedEvidence: readonly EvidenceSpan[];
  refusalExpectation: Readonly<{ required: boolean; reasonCode?: string }>;
  deterministicChecks: Readonly<{ allOfRegex: readonly string[]; noneOfRegex: readonly string[] }>;
  humanReview: Readonly<{ supported: boolean | null; reviewer: string | null; reviewedAt: string | null; notes: string }>;
}>;

export type AccuracyCorpus = Readonly<{
  version: 1;
  fixtureRoot: string;
  questions: readonly AccuracyQuestion[];
}>;

export type AccuracyAnswer = Readonly<{
  questionId: string;
  outcome: "answered" | "refused";
  text: string;
  factIds: readonly string[];
  citations: readonly EvidenceSpan[];
  snapshotDigest: string;
  sessionKey: string;
}>;

export type QuestionScore = Readonly<{
  questionId: string;
  contractValid: boolean;
  factIdsValid: boolean;
  refusalAligned: boolean;
  entityChecksValid: boolean;
  citationsValid: boolean;
  deterministicChecksValid: boolean;
  zeroInventionTrapPassed: boolean | null;
}>;

export type AccuracyMetrics = Readonly<{
  validator_contract_rate: number;
  validator_fact_id_rate: number;
  validator_refusal_alignment_rate: number;
  validator_entity_check_rate: number;
  validator_citation_boundary_rate: number;
  validator_deterministic_check_rate: number;
  retrieval_fixture_question_coverage: number;
  retrieval_fixture_span_coverage: number;
  validator_zero_invention_trap_rate: number;
  model_correctness: "not_measured" | "provisional";
  semantic_support: "needs_human_review";
}>;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertStringArray(value: unknown, label: string): asserts value is string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`Invalid ${label}`);
  }
}

function assertSpan(value: unknown): asserts value is EvidenceSpan {
  if (
    !isObject(value) || typeof value.path !== "string" ||
    !Number.isInteger(value.startLine) || !Number.isInteger(value.endLine) ||
    (value.startLine as number) < 1 || (value.endLine as number) < (value.startLine as number)
  ) throw new Error("Invalid allowed evidence span");
}

export function parseAccuracyCorpus(value: unknown): AccuracyCorpus {
  if (!isObject(value) || value.version !== 1 || typeof value.fixtureRoot !== "string" || !Array.isArray(value.questions)) {
    throw new Error("Invalid accuracy corpus");
  }
  const questions = value.questions.map((raw): AccuracyQuestion => {
    if (!isObject(raw) || typeof raw.id !== "string" || typeof raw.category !== "string" || typeof raw.prompt !== "string") {
      throw new Error("Invalid accuracy question");
    }
    if (!Array.isArray(raw.atomicFacts) || raw.atomicFacts.length === 0 || raw.atomicFacts.some((fact) => !isObject(fact) || typeof fact.id !== "string" || typeof fact.statement !== "string")) {
      throw new Error(`Invalid atomic facts for ${raw.id}`);
    }
    assertStringArray(raw.requiredEntities, `${raw.id} required entities`);
    assertStringArray(raw.forbiddenEntities, `${raw.id} forbidden entities`);
    if (!Array.isArray(raw.allowedEvidence)) throw new Error(`Invalid evidence list for ${raw.id}`);
    raw.allowedEvidence.forEach(assertSpan);
    if (!isObject(raw.refusalExpectation) || typeof raw.refusalExpectation.required !== "boolean") throw new Error(`Invalid refusal expectation for ${raw.id}`);
    if (!isObject(raw.deterministicChecks)) throw new Error(`Invalid deterministic checks for ${raw.id}`);
    assertStringArray(raw.deterministicChecks.allOfRegex, `${raw.id} allOfRegex`);
    assertStringArray(raw.deterministicChecks.noneOfRegex, `${raw.id} noneOfRegex`);
    for (const pattern of [...raw.deterministicChecks.allOfRegex, ...raw.deterministicChecks.noneOfRegex]) new RegExp(pattern, "iu");
    if (!isObject(raw.humanReview) || ![true, false, null].includes(raw.humanReview.supported as never)) throw new Error(`Invalid human review for ${raw.id}`);
    return raw as AccuracyQuestion;
  });
  const questionIds = questions.map(({ id }) => id);
  const factIds = questions.flatMap(({ atomicFacts }) => atomicFacts.map(({ id }) => id));
  if (new Set(questionIds).size !== questionIds.length || new Set(factIds).size !== factIds.length) {
    throw new Error("Accuracy question and fact ids must be unique");
  }
  return { version: 1, fixtureRoot: value.fixtureRoot, questions };
}

export async function loadAccuracyCorpus(): Promise<AccuracyCorpus> {
  return parseAccuracyCorpus(JSON.parse(await readFile(new URL("./questions.json", import.meta.url), "utf8")));
}

function spanKey(span: EvidenceSpan): string {
  return `${span.path}:${span.startLine}-${span.endLine}`;
}

function spanAllowed(citation: EvidenceSpan, allowed: readonly EvidenceSpan[]): boolean {
  return allowed.some((span) =>
    citation.path === span.path && citation.startLine >= span.startLine && citation.endLine <= span.endLine);
}

function rate(values: readonly boolean[]): number {
  return values.length === 0 ? 1 : values.filter(Boolean).length / values.length;
}

export function scoreAccuracyRun(corpus: AccuracyCorpus, answers: readonly AccuracyAnswer[]): {
  scores: QuestionScore[];
  metrics: AccuracyMetrics;
} {
  const answersById = new Map(answers.map((answer) => [answer.questionId, answer]));
  const usedAllowedSpans = new Set<string>();
  const allAllowedSpans = new Set(corpus.questions.flatMap((question) => question.allowedEvidence.map(spanKey)));
  const scores = corpus.questions.map((question): QuestionScore => {
    const answer = answersById.get(question.id);
    const contractValid = answer !== undefined && answer.text.trim().length > 0 && answer.snapshotDigest.length > 0 && answer.sessionKey.length > 0;
    const declaredFacts = new Set(question.atomicFacts.map(({ id }) => id));
    const factIdsValid = answer !== undefined && answer.factIds.length > 0 && answer.factIds.every((id) => declaredFacts.has(id)) && declaredFacts.size === new Set(answer.factIds).size;
    const refusalAligned = answer !== undefined && (answer.outcome === "refused") === question.refusalExpectation.required;
    const entityChecksValid = answer !== undefined &&
      question.requiredEntities.every((entity) => answer.text.toLocaleLowerCase("en-US").includes(entity.toLocaleLowerCase("en-US"))) &&
      (answer.outcome === "refused" || question.forbiddenEntities.every((entity) => !answer.text.toLocaleLowerCase("en-US").includes(entity.toLocaleLowerCase("en-US"))));
    const citationsValid = answer !== undefined &&
      (question.refusalExpectation.required ? answer.citations.length === 0 : answer.citations.length > 0) &&
      answer.citations.every((citation) => spanAllowed(citation, question.allowedEvidence));
    if (citationsValid && answer) {
      for (const citation of answer.citations) {
        const containing = question.allowedEvidence.find((span) => spanAllowed(citation, [span]));
        if (containing) usedAllowedSpans.add(spanKey(containing));
      }
    }
    const deterministicChecksValid = answer !== undefined &&
      question.deterministicChecks.allOfRegex.every((pattern) => new RegExp(pattern, "iu").test(answer.text)) &&
      question.deterministicChecks.noneOfRegex.every((pattern) => !new RegExp(pattern, "iu").test(answer.text));
    const zeroInventionTrapPassed = question.category === "nonexistent_trap"
      ? Boolean(answer && answer.outcome === "refused" && citationsValid && deterministicChecksValid)
      : null;
    return { questionId: question.id, contractValid, factIdsValid, refusalAligned, entityChecksValid, citationsValid, deterministicChecksValid, zeroInventionTrapPassed };
  });
  const answeredQuestions = new Set(answers.map(({ questionId }) => questionId));
  const traps = scores.flatMap(({ zeroInventionTrapPassed }) => zeroInventionTrapPassed === null ? [] : [zeroInventionTrapPassed]);
  return {
    scores,
    metrics: {
      validator_contract_rate: rate(scores.map(({ contractValid }) => contractValid)),
      validator_fact_id_rate: rate(scores.map(({ factIdsValid }) => factIdsValid)),
      validator_refusal_alignment_rate: rate(scores.map(({ refusalAligned }) => refusalAligned)),
      validator_entity_check_rate: rate(scores.map(({ entityChecksValid }) => entityChecksValid)),
      validator_citation_boundary_rate: rate(scores.map(({ citationsValid }) => citationsValid)),
      validator_deterministic_check_rate: rate(scores.map(({ deterministicChecksValid }) => deterministicChecksValid)),
      retrieval_fixture_question_coverage: answeredQuestions.size / corpus.questions.length,
      retrieval_fixture_span_coverage: allAllowedSpans.size === 0 ? 1 : usedAllowedSpans.size / allAllowedSpans.size,
      validator_zero_invention_trap_rate: rate(traps),
      model_correctness: "not_measured",
      semantic_support: "needs_human_review",
    },
  };
}

export async function assertCorpusEvidenceExists(corpus: AccuracyCorpus): Promise<void> {
  const root = resolve(corpus.fixtureRoot);
  for (const question of corpus.questions) {
    for (const span of question.allowedEvidence) {
      const lines = (await readFile(resolve(root, span.path), "utf8")).split(/\r\n|\n|\r/u);
      if (span.endLine > lines.length || lines.slice(span.startLine - 1, span.endLine).join("\n").trim().length === 0) {
        throw new Error(`Empty or out-of-range evidence span: ${question.id} ${spanKey(span)}`);
      }
    }
  }
}
