export type Job = Readonly<{ requestId: string; payload: string }>;
export type JobResult = Readonly<{ requestId: string; status: "completed"; byteLength: number }>;

export function completeJob(job: Job): JobResult {
  return {
    requestId: job.requestId,
    status: "completed",
    byteLength: Buffer.byteLength(job.payload, "utf8"),
  };
}
