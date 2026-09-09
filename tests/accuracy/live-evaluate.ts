import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";

import {
  loadAccuracyCorpus,
  scoreAccuracyRun,
  type AccuracyAnswer,
  type AccuracyCorpus,
  type AccuracyQuestion,
} from "./rubric.js";

export type LiveAccuracyMetadata = Readonly<{
  model: string;
  cliVersion: string;
  fixtureCommit: string;
}>;

export type LiveAccuracyRequest = Readonly<{
  question: AccuracyQuestion;
  fixtureRoot: string;
  sessionKey: string;
  mode: "independent" | "continuity";
}>;

export interface LiveAccuracyRunner {
  metadata(): Promise<LiveAccuracyMetadata>;
  answer(request: LiveAccuracyRequest): Promise<AccuracyAnswer>;
  close(): Promise<void>;
}

export type LiveAccuracyReport = Readonly<{
  reportVersion: 1;
  status: "provisional";
  observedOn: string;
  model: string;
  cliVersion: string;
  fixtureCommit: string;
  seed: number;
  independent: Readonly<{
    order: readonly string[];
    metrics: ReturnType<typeof scoreAccuracyRun>["metrics"];
  }>;
  continuity: Readonly<{
    order: readonly string[];
    metrics: ReturnType<typeof scoreAccuracyRun>["metrics"];
  }>;
  publication: Readonly<{
    modelCorrectness: "not measured";
    directSupportPercentage: "not measured";
    humanAdjudication: "incomplete";
    zeroInventionTrapResult: "provisional";
  }>;
}>;

const CONTINUITY_IDS = ["Q02", "Q07", "Q10"] as const;
const SAFE_METADATA = /^[0-9A-Za-z][0-9A-Za-z ._+:/@-]{0,127}$/u;

function sanitizedMetadata(value: string, label: string): string {
  if (!SAFE_METADATA.test(value) || /[A-Za-z]:[\\/]|\\\\|\/(?:Users|home)\//u.test(value)) {
    throw new Error(`Unsafe live accuracy ${label}`);
  }
  return value;
}

function normalizedSeed(value: number): number {
  if (!Number.isSafeInteger(value)) throw new Error("Accuracy seed must be a safe integer");
  return value >>> 0;
}

function shuffled<T>(values: readonly T[], seed: number): T[] {
  const output = [...values];
  let state = normalizedSeed(seed) || 0x6d2b79f5;
  for (let index = output.length - 1; index > 0; index -= 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const selected = state % (index + 1);
    [output[index], output[selected]] = [output[selected]!, output[index]!];
  }
  return output;
}

function subsetCorpus(corpus: AccuracyCorpus, ids: readonly string[]): AccuracyCorpus {
  const selected = new Set(ids);
  return { ...corpus, questions: corpus.questions.filter(({ id }) => selected.has(id)) };
}

function validateAnswer(answer: AccuracyAnswer, questionId: string, sessionKey: string): AccuracyAnswer {
  if (answer.questionId !== questionId || answer.sessionKey !== sessionKey) {
    throw new Error("Live accuracy adapter crossed a question or session boundary");
  }
  return answer;
}

export async function runLiveAccuracyEvaluation(options: {
  runner: LiveAccuracyRunner;
  seed: number;
  observedOn?: string;
}): Promise<LiveAccuracyReport> {
  const corpus = await loadAccuracyCorpus();
  const metadata = await options.runner.metadata();
  const seed = normalizedSeed(options.seed);
  const order = shuffled(corpus.questions, seed);
  const independent: AccuracyAnswer[] = [];
  const independentSessions = new Set<string>();
  try {
    for (const question of order) {
      const sessionKey = `independent-${question.id}-${seed}`;
      if (independentSessions.has(sessionKey)) throw new Error("Independent live session key was reused");
      independentSessions.add(sessionKey);
      independent.push(validateAnswer(await options.runner.answer({
        question,
        fixtureRoot: corpus.fixtureRoot,
        sessionKey,
        mode: "independent",
      }), question.id, sessionKey));
    }
    const continuityCorpus = subsetCorpus(corpus, CONTINUITY_IDS);
    const continuityOrder = shuffled(continuityCorpus.questions, seed ^ 0xa5a5a5a5);
    const continuitySessionKey = `continuity-${seed}`;
    const continuity: AccuracyAnswer[] = [];
    for (const question of continuityOrder) {
      continuity.push(validateAnswer(await options.runner.answer({
        question,
        fixtureRoot: corpus.fixtureRoot,
        sessionKey: continuitySessionKey,
        mode: "continuity",
      }), question.id, continuitySessionKey));
    }
    return {
      reportVersion: 1,
      status: "provisional",
      observedOn: options.observedOn ?? new Date().toISOString().slice(0, 10),
      model: sanitizedMetadata(metadata.model, "model"),
      cliVersion: sanitizedMetadata(metadata.cliVersion, "CLI version"),
      fixtureCommit: sanitizedMetadata(metadata.fixtureCommit, "fixture commit"),
      seed,
      independent: { order: order.map(({ id }) => id), metrics: scoreAccuracyRun(corpus, independent).metrics },
      continuity: { order: continuityOrder.map(({ id }) => id), metrics: scoreAccuracyRun(continuityCorpus, continuity).metrics },
      publication: {
        modelCorrectness: "not measured",
        directSupportPercentage: "not measured",
        humanAdjudication: "incomplete",
        zeroInventionTrapResult: "provisional",
      },
    };
  } finally {
    await options.runner.close();
  }
}

async function loadRunner(path: string): Promise<LiveAccuracyRunner> {
  const imported = await import(pathToFileURL(resolve(path)).href) as { createLiveAccuracyRunner?: () => Promise<LiveAccuracyRunner> | LiveAccuracyRunner };
  if (typeof imported.createLiveAccuracyRunner !== "function") throw new Error("Live accuracy adapter is missing createLiveAccuracyRunner");
  return await imported.createLiveAccuracyRunner();
}

async function main(): Promise<void> {
  if (process.env.AIMD_LIVE_ACCURACY !== "1") {
    process.stdout.write('{"status":"not_run","reason":"Set AIMD_LIVE_ACCURACY=1 and provide a trusted adapter to run real-model evaluation."}\n');
    return;
  }
  const adapterPath = process.env.AIMD_LIVE_ACCURACY_ADAPTER;
  if (!adapterPath) throw new Error("AIMD_LIVE_ACCURACY_ADAPTER is required for an opt-in live run");
  const seed = Number.parseInt(process.env.AIMD_ACCURACY_SEED ?? "20260904", 10);
  const report = await runLiveAccuracyEvaluation({ runner: await loadRunner(adapterPath), seed });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

function isMainModule(): boolean {
  const argument = process.argv[1];
  return Boolean(argument && resolve(argument) === resolve(fileURLToPath(import.meta.url)));
}

if (isMainModule()) {
  void main().catch(() => {
    process.stderr.write('{"status":"failed","code":"LIVE_ACCURACY_RUN_FAILED"}\n');
    process.exitCode = 1;
  });
}
