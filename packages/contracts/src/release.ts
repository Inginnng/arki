import { z } from "zod";

export const ARKI_VERSION = "0.3.0";
export const ARKI_REPOSITORY = "Inginnng/arki";
export const ARKI_REPOSITORY_URL = `https://github.com/${ARKI_REPOSITORY}`;
const StableVersion = z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u);
export const UpdateCheckSchema = z.object({
  currentVersion: StableVersion,
  latestVersion: StableVersion.nullable(),
  status: z.enum(["available", "up_to_date", "ahead", "no_release", "unavailable"]),
  reason: z.enum(["network", "rate_limited", "invalid_response"]).nullable(),
  releaseUrl: z.string().refine(value => /^https:\/\/github\.com\/Inginnng\/arki\/releases\/tag\/v?\d+\.\d+\.\d+$/u.test(value)).nullable(),
  checkedAt: z.string().datetime(),
}).strict();
export type UpdateCheck = z.infer<typeof UpdateCheckSchema>;
