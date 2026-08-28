import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const dockerfile = readFileSync(new URL("../../Dockerfile.sandbox", import.meta.url), "utf8");
const dockerignore = readFileSync(new URL("../../.dockerignore", import.meta.url), "utf8");

describe("Sandbox Dockerfile", () => {
  test("copies CLI lifecycle scripts before installing workspace dependencies", () => {
    const packageIndex = dockerfile.indexOf(
      "COPY packages/cli/package.json packages/cli/package.json",
    );
    const scriptIndex = dockerfile.indexOf(
      "COPY packages/cli/scripts/warm-cache.mjs packages/cli/scripts/warm-cache.mjs",
    );
    const installIndex = dockerfile.indexOf("RUN pnpm install --frozen-lockfile");

    expect(packageIndex).toBeGreaterThanOrEqual(0);
    expect(scriptIndex).toBeGreaterThan(packageIndex);
    expect(installIndex).toBeGreaterThan(scriptIndex);
    expect(dockerignore).toContain("!packages/cli/scripts/");
    expect(dockerignore).toContain("!packages/cli/scripts/warm-cache.mjs");
  });
});
