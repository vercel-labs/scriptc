import { globSync } from "node:fs";
import { basename, join } from "node:path";
import { test } from "vitest";
import { balancedShardSelect } from "./shard.js";
import { checkEffectFixture, effectFixtureTimeout } from "./effect-runner.js";
import fixtureCosts from "./effect-costs.json";

const sanitize = process.env["SCRIPTC_SAN"] === "1";
const fixtures = globSync(join(import.meta.dirname, "../fixtures/effect/*.ts")).sort();
const costs: Record<string, number> = fixtureCosts;
const cases = balancedShardSelect(
  fixtures,
  (file) => basename(file),
  (file) => costs[basename(file)] ?? 120,
);
const concurrent = process.env["SCRIPTC_EFFECT_TEST_CONCURRENCY"] === "2";

test.for(cases)(
  "published Effect %s matches Node statically",
  { concurrent, timeout: effectFixtureTimeout },
  async (entry) => {
    await checkEffectFixture(
      entry,
      ["effect", "fast-check", "pure-rand"],
      sanitize ? "dev" : "release",
    );
  },
);
