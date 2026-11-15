import { globSync } from "node:fs";
import { basename, join } from "node:path";
import { test } from "vitest";
import { balancedShardSelect } from "./shard.js";
import { checkEffectFixture, effectFixtureTimeout } from "./effect-runner.js";
import fixtureCosts from "./effect4-costs.json";

const fixtures = globSync(join(import.meta.dirname, "../fixtures/effect4/*.ts"))
  .filter((file) => !file.endsWith(".d.ts"))
  .sort();
// Recorded plain/sanitizer fixture seconds guide scheduling only. New fixtures
// receive an estimate and remain in every complete matrix partition.
const costs: Record<string, number> = fixtureCosts;
const cases = balancedShardSelect(
  fixtures,
  (file) => basename(file),
  (file) => costs[basename(file)] ?? 40,
);
const concurrent = process.env["SCRIPTC_EFFECT_TEST_CONCURRENCY"] === "2";

test.for(cases)(
  "published Effect 4 %s matches Node statically",
  { concurrent, timeout: effectFixtureTimeout },
  async (entry) => {
    await checkEffectFixture(
      entry,
      ["effect", "@effect/platform-node", "@effect/platform-node-shared", "undici"],
      "dev",
    );
  },
);
