import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const packagesRoot = fileURLToPath(new URL("../..", import.meta.url));
const platformPacks = readdirSync(packagesRoot)
  .filter((name) => name.startsWith("runtime-") && name !== "runtime-pack-common")
  .filter((name) => existsSync(join(packagesRoot, name, "scripts", "build.mjs")))
  .sort();

// A platform pack with its own builder or matrix falls behind the shared one
// whenever a runtime unit, vendor archive or macro is added there, and the
// gap shows only when that platform's pack is built (0.4.15's darwin-arm64
// pack shipped without the ML-KEM archive this way). Every pack is a thin
// wrapper that configures the shared builder.
test("every platform runtime pack builds with the shared builder and matrix", () => {
  expect(platformPacks.length).toBeGreaterThan(10);
  for (const name of platformPacks) {
    const build = readFileSync(join(packagesRoot, name, "scripts", "build.mjs"), "utf8");
    expect(build, `${name}/scripts/build.mjs`).toContain("runtime-pack-common/scripts/build.mjs");
    expect(existsSync(join(packagesRoot, name, "runtime-pack-matrix.mjs")), name).toBe(false);
  }
});
