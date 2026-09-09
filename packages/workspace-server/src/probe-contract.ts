import { z } from "zod";

export const PROBE_RESOURCE_URI = "ui://aimd/probe.html";
export const PROBE_SOURCE_URI = "aimd-evidence://probe/source";
export const OPEN_PROBE_TOOL_NAME = "aimd_open_capability_probe";
export const PROBE_TOOL_NAME = "aimd_run_capability_probe";

/** A controlled, non-project source used only to prove the MCP Apps source-peek loop. */
export const PROBE_SOURCE_TEXT = "AIMD capability probe source: exact bytes are hash checked.\n";

export const ProbeGateIdSchema = z.enum(["P0-A", "P0-B", "P0-C", "P0-D", "P0-E"]);
export const ProbeOutcomeSchema = z.enum([
  "passed",
  "failed",
  "unsupported",
  "not_run",
  "inconclusive",
]);

/**
 * Public reports never carry host-authored prose. Every accepted summary is a
 * server-owned constant so unknown ids, paths, excerpts, and future secret
 * shapes fail closed without relying on an incomplete denylist.
 */
export const PROBE_GATE_SUMMARIES = [
  "The browser must complete and verify the MCP Apps loop.",
  "Exact task binding requires an explicit live host probe.",
  "Ephemeral fork creation requires an explicit live host probe.",
  "Context fidelity requires an explicit live fixture probe.",
  "The complete failure matrix was not run by this entry point.",
  "The capability probe failed at its trusted server boundary.",
  "Exact task binding was not evaluated.",
  "Ephemeral fork creation was not evaluated.",
  "Context fidelity was not evaluated.",
  "The failure matrix did not complete.",
  "The MCP Apps loop completed.",
  "The MCP Apps resource challenge completed.",
  "The resource challenge completed, but host UI provenance was not attested.",
  "Exact task binding was verified.",
  "Exact task binding could not be verified.",
  "The App Server capability was unavailable.",
  "An exact ephemeral fork was verified.",
  "The exact ephemeral fork could not be verified.",
  "Context fidelity checks failed safely.",
  "Live task metadata is required.",
  "Synthetic failures fail closed.",
] as const;

export const ProbeGateSummarySchema = z.enum(PROBE_GATE_SUMMARIES);
export const ProbeDiagnosticCodeSchema = z.enum([
  "PROBE_INTERNAL_FAILURE",
  "HOST_CAPABILITY_UNAVAILABLE",
  "TASK_BINDING_UNAVAILABLE",
  "EPHEMERAL_FORK_UNAVAILABLE",
  "CONTEXT_FIDELITY_UNVERIFIED",
  "FAILURE_MATRIX_INCOMPLETE",
  "UI_PROVENANCE_UNATTESTED",
]);

type ProbeGateStatus = {
  readonly id: z.infer<typeof ProbeGateIdSchema>;
  readonly status: z.infer<typeof ProbeOutcomeSchema>;
};

export type CapabilityFeatureFlags = {
  readonly task_and_project: boolean;
  readonly project_only: boolean;
  readonly reader_only: boolean;
};

export function deriveCapabilityFeatureFlags(
  gates: readonly ProbeGateStatus[],
): CapabilityFeatureFlags {
  const statuses = new Map(gates.map((gate) => [gate.id, gate.status]));
  const readerAvailable = statuses.get("P0-A") === "passed";
  const projectOnly = readerAvailable &&
    statuses.get("P0-D") === "passed" &&
    statuses.get("P0-E") === "passed";
  const taskAndProject = projectOnly && ["P0-B", "P0-C"].every(
    (id) => statuses.get(id as ProbeGateStatus["id"]) === "passed",
  );
  return {
    task_and_project: taskAndProject,
    project_only: projectOnly,
    reader_only: readerAvailable && !projectOnly,
  };
}

export const CapabilityProbeReportSchema = z
  .object({
    reportVersion: z.literal(1),
    gates: z
      .array(
        z
          .object({
            id: ProbeGateIdSchema,
            status: ProbeOutcomeSchema,
            summary: ProbeGateSummarySchema,
            diagnosticCode: ProbeDiagnosticCodeSchema.optional(),
          })
          .strict(),
      )
      .length(5),
    featureFlags: z
      .object({
        task_and_project: z.boolean(),
        project_only: z.boolean(),
        reader_only: z.boolean(),
      })
      .strict(),
    sourcePeek: z
      .object({
        uri: z.literal(PROBE_SOURCE_URI),
        excerptHash: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict(),
  })
  .strict()
  .superRefine((report, context) => {
    const ids = report.gates.map((gate) => gate.id);
    const expected = ProbeGateIdSchema.options;
    if (new Set(ids).size !== expected.length || expected.some((id) => !ids.includes(id))) {
      context.addIssue({
        code: "custom",
        path: ["gates"],
        message: "Capability reports must contain P0-A through P0-E exactly once",
      });
    }
    const expectedFlags = deriveCapabilityFeatureFlags(report.gates);
    if (
      report.featureFlags.task_and_project !== expectedFlags.task_and_project ||
      report.featureFlags.project_only !== expectedFlags.project_only ||
      report.featureFlags.reader_only !== expectedFlags.reader_only
    ) {
      context.addIssue({
        code: "custom",
        path: ["featureFlags"],
        message: "Capability feature flags must be derived exactly from P0-A through P0-E",
      });
    }
  });

export type ProbeGateId = z.infer<typeof ProbeGateIdSchema>;
export type ProbeOutcome = z.infer<typeof ProbeOutcomeSchema>;
export type CapabilityProbeReport = z.infer<typeof CapabilityProbeReportSchema>;

export function parseCapabilityProbeReport(value: unknown): CapabilityProbeReport {
  return CapabilityProbeReportSchema.parse(value);
}
