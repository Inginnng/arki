import { completeJob, type JobResult } from "./worker.js";

export type GatewayRequest = Readonly<{ requestId: string; payload: string }>;

export function handleRequest(request: GatewayRequest): JobResult {
  const requestId = request.requestId.trim();
  if (requestId.length === 0) throw new TypeError("requestId is required");
  return completeJob({ requestId, payload: request.payload });
}
