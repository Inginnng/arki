# Sample Project

This fixture models a small request pipeline used by AIMD Reader integration tests.

## Architecture

`src/gateway.ts` validates an incoming request and forwards a normalized job to
`src/worker.ts`. The worker returns a deterministic completion record.

## Request flow

1. The gateway receives a request.
2. The gateway creates a normalized job.
3. The worker completes the job.
