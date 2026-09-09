import { createServer } from "node:http";
import { afterEach, expect, it } from "vitest";
// @ts-expect-error The portable Node launcher intentionally has no TypeScript runtime.
import { inspectBackend, projectKey } from "../../scripts/arki.mjs";
const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve())))); });
it("reuses only an Arki backend attesting the same project, never an unrelated listener", async () => {
  const key = projectKey("/project/one"); let body: unknown = { ok: true, product: "arki", projectKey: key, instanceId: "instance" };
  const server = createServer((_request, response) => response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body)));
  servers.push(server); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw Error("listen");
  expect(await inspectBackend(address.port, key)).toMatchObject({ instanceId: "instance" });
  expect(await inspectBackend(address.port, projectKey("/project/two"))).toBeNull();
  body = { ok: true, projectKey: key }; expect(await inspectBackend(address.port, key)).toBeNull();
  body = "not a health response"; expect(await inspectBackend(address.port, key)).toBeNull();
});
