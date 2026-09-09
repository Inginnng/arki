// GENERATED COMPATIBILITY FACADE. DO NOT EDIT BY HAND.
// Source: Codex App Server schema recorded in ../generated/VERSION.md.

export const GENERATED_APP_SERVER_SCHEMA_VERSION = "0.151.0-alpha.7.2" as const;

export type GeneratedJsonValue =
  | null
  | boolean
  | number
  | string
  | GeneratedJsonValue[]
  | { [key: string]: GeneratedJsonValue | undefined };

export type GeneratedInitializeParamsAdapter = {
  clientInfo: { name: string; title: string | null; version: string };
  capabilities: {
    experimentalApi: boolean;
    requestAttestation: boolean;
    mcpServerOpenaiFormElicitation?: boolean;
    optOutNotificationMethods?: string[] | null;
    extensions?: { [key: string]: GeneratedJsonValue | undefined } | null;
  } | null;
};

export type GeneratedInitializeResponseAdapter = {
  userAgent: string;
  codexHome: string;
  platformFamily: string;
  platformOs: string;
};

export type GeneratedThreadReadParamsAdapter = {
  threadId: string;
  includeTurns?: boolean;
};

export type GeneratedThreadForkParamsAdapter = {
  threadId: string;
  lastTurnId?: string | null;
  cwd?: string | null;
  runtimeWorkspaceRoots?: string[] | null;
  approvalPolicy?: "never" | null;
  sandbox?: "read-only" | null;
  config?: { [key: string]: GeneratedJsonValue | undefined } | null;
  developerInstructions?: string | null;
  ephemeral?: boolean;
  deferGoalContinuation?: boolean;
};

export type GeneratedThreadStartParamsAdapter = {
  cwd?: string | null;
  runtimeWorkspaceRoots?: string[] | null;
  approvalPolicy?: "never" | null;
  sandbox?: "read-only" | null;
  config?: { [key: string]: GeneratedJsonValue | undefined } | null;
  developerInstructions?: string | null;
  ephemeral?: boolean | null;
  environments?: unknown[] | null;
  dynamicTools?: unknown[] | null;
  selectedCapabilityRoots?: unknown[] | null;
};

export type GeneratedTurnStartParamsAdapter = {
  threadId: string;
  input: Array<{ type: "text"; text: string; text_elements: unknown[] }>;
  environments?: unknown[] | null;
  cwd?: string | null;
  runtimeWorkspaceRoots?: string[] | null;
  approvalPolicy?: "never" | null;
  sandboxPolicy?: { type: "readOnly"; networkAccess: boolean } | null;
  outputSchema?: GeneratedJsonValue | null;
};

export type GeneratedTurnInterruptParamsAdapter = {
  threadId: string;
  turnId: string;
};

export type GeneratedTurnStatusAdapter =
  | "completed"
  | "interrupted"
  | "failed"
  | "inProgress";

export type GeneratedTurnAdapter = {
  id: string;
  status: GeneratedTurnStatusAdapter;
  items: unknown[];
  startedAt: number | null;
  completedAt: number | null;
};

export type GeneratedThreadAdapter = {
  id: string;
  cwd: string;
  ephemeral: boolean;
  forkedFromId: string | null;
  status: { type: string };
  turns: GeneratedTurnAdapter[];
};

export type GeneratedThreadResponseAdapter = { thread: GeneratedThreadAdapter };
export type GeneratedTurnStartResponseAdapter = { turn: GeneratedTurnAdapter };
