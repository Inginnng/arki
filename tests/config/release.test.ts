import { expect,it } from "vitest";
import { fileURLToPath } from "node:url";
import { ARKI_VERSION } from "../../packages/contracts/src/release.js";
// @ts-expect-error The portable release tools run without a TypeScript runtime.
import { checkRelease } from "../../scripts/check-release.mjs";
it("keeps the public version, plugin and user documentation in sync",async()=>{
 const root=fileURLToPath(new URL("../..",import.meta.url));expect(await checkRelease(root)).toMatchObject({version:ARKI_VERSION});
 await expect(checkRelease(root,"v999.0.0")).rejects.toThrow("does not match");
});
