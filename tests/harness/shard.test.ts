/* The partition function's contract: the union of the n shards is the whole
 * list with every item EXACTLY once (no drops, no duplicates), assignment
 * depends only on the item's key (list growth never moves an existing item),
 * and no spec means everything. differential/llvm-differential/npm/server
 * lean on these properties for CI sharding — see shard.ts. */
import { globSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  balancedShardSelect,
  corpusCostFiles,
  corpusSelect,
  loadCorpusCosts,
  parseShardSpec,
  shardOf,
  shardSelect,
  shardSuffix,
  skipUnownedTest,
} from "./shard.js";
import fixtureCosts from "./effect4-costs.json";
import effectCosts from "./effect-costs.json";

const corpusDir = join(import.meta.dirname, "../corpus");

// The default parameters read SCRIPTC_TEST_SHARD, and CI sets it job-wide —
// these tests must see a controlled environment, not the job's slice.
const ambient = process.env["SCRIPTC_TEST_SHARD"];
beforeAll(() => {
  delete process.env["SCRIPTC_TEST_SHARD"];
});
afterAll(() => {
  if (ambient !== undefined) process.env["SCRIPTC_TEST_SHARD"] = ambient;
});

describe("parseShardSpec", () => {
  test("unset and empty mean no sharding", () => {
    expect(parseShardSpec(undefined)).toBeUndefined();
    expect(parseShardSpec("")).toBeUndefined();
  });

  test("defaults to SCRIPTC_TEST_SHARD", () => {
    process.env["SCRIPTC_TEST_SHARD"] = "2/3";
    try {
      expect(parseShardSpec()).toEqual({ index: 2, count: 3 });
      expect(shardSuffix()).toBe(", shard 2/3");
    } finally {
      delete process.env["SCRIPTC_TEST_SHARD"];
    }
  });

  test("parses i/n", () => {
    expect(parseShardSpec("2/3")).toEqual({ index: 2, count: 3 });
    expect(parseShardSpec("1/1")).toEqual({ index: 1, count: 1 });
    expect(parseShardSpec("10/12")).toEqual({ index: 10, count: 12 });
  });

  test("throws on malformed and out-of-range specs", () => {
    for (const bad of ["0/3", "4/3", "1/0", "1-3", "a/b", "1/3 ", "-1/3", "1/", "/3"]) {
      expect(() => parseShardSpec(bad), bad).toThrow();
    }
  });
});

describe("shardSelect", () => {
  const keys = Array.from({ length: 1000 }, (_, i) => `program-${i}.ts`);

  test("no spec returns everything unchanged", () => {
    expect(shardSelect(keys, (k) => k, undefined)).toEqual(keys);
    expect(shardSelect(keys, (k) => k, { index: 1, count: 1 })).toEqual(keys);
  });

  test.for([2, 3, 4, 5, 7, 10])("the union of %i shards is every item exactly once", (n) => {
    const union = Array.from({ length: n }, (_, i) =>
      shardSelect(keys, (k) => k, { index: i + 1, count: n }),
    ).flat();
    expect(union.length).toBe(keys.length); // disjoint: no item counted twice
    expect([...union].sort()).toEqual([...keys].sort()); // complete: none dropped
  });

  test.for([3, 5, 6, 10])("the real corpus partitions completely under %i shards", (count) => {
    // The exact list differential.test.ts globs, keyed the same way.
    const files = ["ts", "js", "mjs", "cjs"]
      .flatMap((ext) => [
        ...globSync(join(corpusDir, `*.${ext}`)),
        ...globSync(join(corpusDir, `*/main.${ext}`)),
      ])
      .sort()
      .map((f) => f.slice(corpusDir.length + 1));
    expect(files.length).toBeGreaterThan(0);
    const union = Array.from({ length: count }, (_, i) =>
      shardSelect(files, (k) => k, { index: i + 1, count }),
    ).flat();
    expect(union.length).toBe(files.length);
    expect([...union].sort()).toEqual(files);
  });

  test("assignment is per-key: growing the list never moves an existing item", () => {
    const spec = { index: 2, count: 3 };
    const before = shardSelect(keys.slice(0, 400), (k) => k, spec);
    const after = shardSelect(keys, (k) => k, spec);
    expect(after.slice(0, before.length)).toEqual(before);
  });

  test("shardOf is deterministic and in range", () => {
    for (const k of keys.slice(0, 50)) {
      const s = shardOf(k, 3);
      expect(s).toBe(shardOf(k, 3));
      expect(s).toBeGreaterThanOrEqual(1);
      expect(s).toBeLessThanOrEqual(3);
    }
  });
});

describe("shardSuffix", () => {
  test("names the shard under a spec, empty otherwise", () => {
    expect(shardSuffix({ index: 2, count: 3 })).toBe(", shard 2/3");
    expect(shardSuffix(undefined)).toBe("");
  });
});

describe("balancedShardSelect", () => {
  const costs: Record<string, number> = fixtureCosts;
  const fixtures = globSync(join(import.meta.dirname, "../fixtures/effect4/*.ts"))
    .filter((file) => !file.endsWith(".d.ts"))
    .map((file) => basename(file))
    .sort();
  const weight = (key: string) => costs[key] ?? 40;

  test.for([2, 3, 5, 8, 10, 12, 16])(
    "the published fixtures partition completely and independently of input order with %i shards",
    (count) => {
      const parts = Array.from({ length: count }, (_, index) =>
        balancedShardSelect(fixtures, (key) => key, weight, { index: index + 1, count }),
      );
      expect(parts.flat().sort()).toEqual(fixtures);
      expect(new Set(parts.flat()).size).toBe(fixtures.length);
      for (let index = 0; index < count; index++) {
        expect(
          balancedShardSelect([...fixtures].reverse(), (key) => key, weight, {
            index: index + 1,
            count,
          }).sort(),
        ).toEqual(parts[index]);
      }
    },
  );

  test("cost balancing reduces the longest recorded Effect 4 slice", () => {
    const keys = Object.keys(costs);
    const total = (slice: string[]) => slice.reduce((sum, key) => sum + weight(key), 0);
    const hashed = Array.from({ length: 10 }, (_, index) =>
      total(shardSelect(keys, (key) => key, { index: index + 1, count: 10 })),
    );
    const balanced = Array.from({ length: 10 }, (_, index) =>
      total(balancedShardSelect(keys, (key) => key, weight, { index: index + 1, count: 10 })),
    );
    expect(Math.max(...balanced)).toBeLessThan(Math.max(...hashed) * 0.8);
  });

  test.for([10, 12, 16])(
    "published Effect 3 fixtures also balance without dropping cases across %i shards",
    (count) => {
      const costs: Record<string, number> = effectCosts;
      const keys = globSync(join(import.meta.dirname, "../fixtures/effect/*.ts"))
        .map((file) => basename(file))
        .sort();
      const weight = (key: string) => costs[key] ?? 120;
      const parts = Array.from({ length: count }, (_, index) =>
        balancedShardSelect(keys, (key) => key, weight, { index: index + 1, count }),
      );
      expect(parts.flat().sort()).toEqual(keys);
      const total = (slice: string[]) => slice.reduce((sum, key) => sum + weight(key), 0);
      const hashed = Array.from({ length: 10 }, (_, index) =>
        total(shardSelect(keys, (key) => key, { index: index + 1, count: 10 })),
      );
      expect(Math.max(...parts.map(total))).toBeLessThan(Math.max(...hashed) * 0.8);
    },
  );

  test("new fixtures remain selected and local runs keep every fixture", () => {
    const keys = [...fixtures, "new-fixture.ts"];
    expect(balancedShardSelect(keys, (key) => key, weight, undefined)).toEqual(keys);
    expect(balancedShardSelect(keys, (key) => key, weight, { index: 1, count: 1 })).toEqual(keys);
    const parts = Array.from({ length: 3 }, (_, index) =>
      balancedShardSelect(keys, (key) => key, weight, { index: index + 1, count: 3 }),
    );
    expect(parts.flat().sort()).toEqual(keys.sort());
  });

  test("ambiguous keys and invalid costs throw instead of dropping fixtures", () => {
    const spec = { index: 1, count: 2 };
    expect(() =>
      balancedShardSelect(
        ["same", "same"],
        (key) => key,
        () => 1,
        spec,
      ),
    ).toThrow(/duplicate/);
    for (const weight of [0, -1, Infinity, NaN]) {
      expect(() =>
        balancedShardSelect(
          ["fixture"],
          (key) => key,
          () => weight,
          spec,
        ),
      ).toThrow(/weight/);
    }
  });
});

test("skipUnownedTest runs each test of a suite on exactly one shard, longest apart", () => {
  // Two tests share a title, as test.each titles without parameters do.
  const names = [...Array.from({ length: 39 }, (_, index) => `case ${index}`), "case 0"];
  // Most tests measured at a second, two long ones, and the last five unmeasured.
  const costs: Record<string, number> = Object.fromEntries(
    names.slice(0, 35).map((name) => [name, 1_000]),
  );
  costs["case 3"] = 200_000;
  costs["case 7"] = 150_000;
  // One suite per process, as in a CI shard: the owners are computed once per suite.
  const runs = (spec: { index: number; count: number } | undefined) => {
    const suite = { tasks: [] as { name: string }[] };
    suite.tasks = names.map((name) => ({ type: "test", name, suite }));
    return suite.tasks
      .filter((task) => {
        let skipped = false;
        skipUnownedTest(
          { task, skip: () => (skipped = true) } as unknown as Parameters<
            typeof skipUnownedTest
          >[0],
          costs,
          spec,
        );
        return !skipped;
      })
      .map((task) => task.name);
  };
  expect(runs(undefined)).toEqual(names);
  const shards = Array.from({ length: 5 }, (_, index) => runs({ index: index + 1, count: 5 }));
  expect(shards.flat().toSorted()).toEqual(names.toSorted());
  // The two long tests hold shards of their own.
  expect(shards.find((shard) => shard.includes("case 3"))).toEqual(["case 3"]);
  expect(shards.find((shard) => shard.includes("case 7"))).toEqual(["case 7"]);
});

describe("corpusSelect", () => {
  const programs = ["ts", "js", "mjs", "cjs"]
    .flatMap((ext) => [
      ...globSync(join(corpusDir, `*.${ext}`)),
      ...globSync(join(corpusDir, `*/main.${ext}`)),
    ])
    .map((file) => file.slice(corpusDir.length + 1))
    .sort();

  test.each([false, true])(
    "every corpus program runs exactly once over the 10 shards (sanitize %s)",
    (san) => {
      const shards = Array.from({ length: 10 }, (_, i) =>
        corpusSelect(programs, (k) => k, san, { index: i + 1, count: 10 }),
      );
      const union = shards.flat();
      expect(union.length).toBe(programs.length);
      expect(new Set(union)).toEqual(new Set(programs));
      // Both corpus harnesses call corpusSelect with the same keys, so they agree on each shard.
      expect(corpusSelect(programs, (k) => k, san, { index: 3, count: 10 })).toEqual(shards[2]);
    },
  );

  test("measured costs cover the corpus and balance the shards", () => {
    const costs = loadCorpusCosts().plain;
    const measured = programs.filter((k) => costs[k] !== undefined).length;
    expect(measured / programs.length).toBeGreaterThan(0.9);
    const loads = Array.from({ length: 10 }, (_, i) =>
      corpusSelect(programs, (k) => k, false, { index: i + 1, count: 10 }).reduce(
        (sum, k) => sum + (costs[k] ?? 0),
        0,
      ),
    );
    expect(Math.max(...loads) / Math.min(...loads)).toBeLessThan(1.1);
  });

  test("every per-program cost file names a corpus program", () => {
    const known = new Set(programs);
    for (const key of corpusCostFiles().keys())
      expect(known, `corpus-costs/${key}.json`).toContain(key);
  });

  test("per-program cost files override the table, and invalid ones throw", () => {
    const dir = join(
      import.meta.dirname,
      "../../node_modules/.cache/scriptc-tests/corpus-costs-files",
    );
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(join(dir, "200-dir"), { recursive: true });
    writeFileSync(join(dir, "100-flat.ts.json"), '{ "plain": 2500, "san": 4000 }\n');
    writeFileSync(join(dir, "200-dir/main.ts.json"), '{ "san": 900 }\n');
    expect([...corpusCostFiles(dir)]).toEqual([
      ["100-flat.ts", { plain: 2500, san: 4000 }],
      ["200-dir/main.ts", { san: 900 }],
    ]);
    for (const bad of ['{ "plian": 1 }', '{ "plain": 0 }', '{ "san": "9" }']) {
      writeFileSync(join(dir, "100-flat.ts.json"), bad);
      expect(() => corpusCostFiles(dir)).toThrow(/plain|san/);
    }
    rmSync(dir, { recursive: true, force: true });
  });
});
