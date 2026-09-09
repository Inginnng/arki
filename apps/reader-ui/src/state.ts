import type { Disposition, EvidenceAnswer, QuestionRunStatus } from "@aimd/contracts";

import type { PatchPreview, ReaderDocument, SourcePeek } from "./host.js";
import type { SourceSelection } from "./selection.js";

export type UiQuestionStatus = QuestionRunStatus | "unsupported";

export type UiQuestion = {
  runId: string;
  question: string;
  status: UiQuestionStatus;
  message?: string;
  answer?: EvidenceAnswer;
};

export type UiAnnotation = {
  id: string;
  selection: SourceSelection;
  questions: UiQuestion[];
  disposition: Disposition;
  orphaned: boolean;
};

export type ReaderState = {
  rootId: string | null;
  document: ReaderDocument | null;
  selection: SourceSelection | null;
  annotations: UiAnnotation[];
  patch: PatchPreview | null;
  approvalToken: string | null;
  sourcePeek: SourcePeek | null;
  notice: string | null;
};

export const initialReaderState: ReaderState = {
  rootId: null,
  document: null,
  selection: null,
  annotations: [],
  patch: null,
  approvalToken: null,
  sourcePeek: null,
  notice: null,
};

export type ReaderAction =
  | { type: "root_selected"; rootId: string }
  | { type: "document_loaded"; document: ReaderDocument }
  | { type: "selection_captured"; selection: SourceSelection }
  | { type: "selection_cleared" }
  | { type: "question_started"; runId: string; question: string; selection: SourceSelection; documentPath: string }
  | { type: "question_progress"; runId: string; status: Extract<QuestionRunStatus, "queued" | "inspecting" | "streaming_unverified" | "validating">; message?: string }
  | { type: "question_finished"; runId: string; status: Extract<UiQuestionStatus, "completed" | "stale" | "unsupported" | "cancelled" | "failed">; answer?: EvidenceAnswer; message?: string }
  | { type: "disposition_changed"; annotationId: string; disposition: Disposition }
  | { type: "anchor_orphaned"; annotationId: string }
  | { type: "patch_prepared"; patch: PatchPreview }
  | { type: "patch_cleared" }
  | { type: "patch_approved"; approvalToken: string }
  | { type: "source_opened"; source: SourcePeek }
  | { type: "source_closed" }
  | { type: "notice"; notice: string | null };

function sameSelection(left: SourceSelection, right: SourceSelection): boolean {
  return left.startOffset === right.startOffset && left.endOffset === right.endOffset;
}

function updateQuestion(state: ReaderState, runId: string, update: (question: UiQuestion) => UiQuestion): UiAnnotation[] {
  return state.annotations.map((annotation) => ({
    ...annotation,
    questions: annotation.questions.map((question) => question.runId === runId ? update(question) : question),
  }));
}

export function readerReducer(state: ReaderState, action: ReaderAction): ReaderState {
  switch (action.type) {
    case "root_selected":
      return { ...initialReaderState, rootId: action.rootId };
    case "document_loaded": {
      const pathChanged = state.document !== null && state.document.path !== action.document.path;
      if (pathChanged) {
        return { ...initialReaderState, rootId: state.rootId, document: action.document };
      }
      const changed = state.document !== null && state.document.hash !== action.document.hash;
      return {
        ...state,
        document: action.document,
        selection: null,
        ...(changed ? {
          annotations: state.annotations.map((annotation) => ({ ...annotation, orphaned: true })),
          patch: null,
          approvalToken: null,
          sourcePeek: null,
          notice: "文档已更改；先前选区需要重新审核，已生成的补丁及审批已失效。",
        } : {}),
      };
    }
    case "selection_captured":
      return { ...state, selection: action.selection, notice: null };
    case "selection_cleared":
      return { ...state, selection: null };
    case "question_started": {
      if (state.document?.path !== action.documentPath) {
        return { ...state, notice: "文档已切换；迟到的提问结果未附加到当前文档。" };
      }
      const existing = state.annotations.find((annotation) => sameSelection(annotation.selection, action.selection));
      const question: UiQuestion = { runId: action.runId, question: action.question, status: "queued" };
      return {
        ...state,
        annotations: existing
          ? state.annotations.map((annotation) => annotation === existing ? { ...annotation, questions: [...annotation.questions, question] } : annotation)
          : [...state.annotations, { id: action.runId, selection: action.selection, questions: [question], disposition: "reading_only", orphaned: false }],
      };
    }
    case "question_progress":
      return { ...state, annotations: updateQuestion(state, action.runId, (question) => ({ ...question, status: action.status, ...(action.message ? { message: action.message } : {}) })) };
    case "question_finished":
      return { ...state, annotations: updateQuestion(state, action.runId, (question) => ({ ...question, status: action.status, ...(action.answer ? { answer: action.answer } : {}), ...(action.message ? { message: action.message } : {}) })) };
    case "disposition_changed":
      return { ...state, annotations: state.annotations.map((annotation) => annotation.id === action.annotationId ? { ...annotation, disposition: action.disposition } : annotation), approvalToken: null };
    case "anchor_orphaned":
      return { ...state, annotations: state.annotations.map((annotation) => annotation.id === action.annotationId ? { ...annotation, orphaned: true } : annotation), approvalToken: null };
    case "patch_prepared":
      return { ...state, patch: action.patch, approvalToken: null };
    case "patch_cleared":
      return { ...state, patch: null, approvalToken: null };
    case "patch_approved":
      return { ...state, approvalToken: action.approvalToken };
    case "source_opened":
      return { ...state, sourcePeek: action.source };
    case "source_closed":
      return { ...state, sourcePeek: null };
    case "notice":
      return { ...state, notice: action.notice };
  }
}
