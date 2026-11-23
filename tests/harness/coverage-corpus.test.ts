// The corpus half of the coverage sweep. It splits the corpus across the plain CI shards
// (SCRIPTC_TEST_SHARD, tests/harness/shard.ts); the report snapshots and fixtures in coverage.test.ts
// run once per CI run, in the coverage job (.github/workflows/ci.yml), so a stale snapshot fails one job.
import { globSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { analyze } from "@scriptc/compiler";
import { shardSelect, shardSuffix } from "./shard.js";

const repoRoot = join(import.meta.dirname, "../..");

test(`every corpus program is 100% static (corpus and coverage agree${shardSuffix()})`, async () => {
  // The differential corpus compiles by definition; coverage must agree.

  // The sweep runs minutes on slow machines and each analyze() blocks the
  // worker thread — without the periodic yield, vitest's worker RPC starves
  // ("Timeout calling onTaskUpdate") even while every check passes, and the
  // default per-test timeout is far too small for a whole-corpus analysis.
  let n = 0;
  const flatEntries = shardSelect(
    ["ts", "js", "mjs", "cjs"]
      .flatMap((ext) => globSync(join(repoRoot, `tests/corpus/*.${ext}`)))
      .sort(),
    (file) => file.slice(repoRoot.length + 1),
  );
  for (const file of flatEntries) {
    const firstLine = readFileSync(file, "utf8").split("\n", 1)[0] ?? "";
    // `// @deferred-fences: N` on the first line: a JS program that
    // DELIBERATELY carries N runtime-fence statements on untaken paths
    // (the deferred-fence corpus) — it still passes the differential
    // oracle because the fences never execute.
    const deferred = /^\/\/ @deferred-fences:\s*(\d+)\s*$/.exec(firstLine);
    const { coverage } = analyze(file, {});
    expect.soft(coverage.diagnostics, file).toEqual([]);
    // Corpus programs match Node on the path the corpus runs: a divergence
    // warning on one is a false positive, except SC6001, SC6012, SC6013 and SC6014. SC6001
    // is sound rather than exact: it names every conversion that copies a
    // value the program could tell from the original
    // (lowering/width-copies.ts), and a corpus program can hold one on a
    // path it does not take. What keeps it honest is
    // tests/harness/copy-soundness.test.ts, which counts the conversions
    // that copy and the warnings that were not needed. SC6012 names a
    // refused statement inside its own try block, and a corpus program that
    // has one is written so that Node throws there too (a guarded require
    // of a module that is not there), which is how it matches. SC6013 names
    // a member written on a promise, a statement that throws when it runs
    // on a promise the program made: a corpus program that has one keeps it
    // on a path the corpus does not take
    // (9523-promise-intersection-plain.ts).
    // SC6014 names a record type whose values create their keys in an order
    // the compiler could not follow: like SC6001 it judges the type, not the
    // path one value takes, so a corpus program can hold one for objects
    // whose keys happen to arrive in the type's order. SC6002, which names
    // one object literal whose keys enumerate in another order than it
    // wrote them, stays a false positive here.
    // SC6015 names a TypeScript statement that throws when it runs, and a
    // corpus program that has one does not reach it (`new` through a held
    // constructor, or a member read on a held loader, on a path the corpus
    // does not take).
    expect
      .soft(
        (coverage.divergences ?? []).filter(
          (d) =>
            d.code !== "SC6001" &&
            d.code !== "SC6012" &&
            d.code !== "SC6013" &&
            d.code !== "SC6014" &&
            d.code !== "SC6015",
        ),
        file,
      )
      .toEqual([]);
    expect.soft(coverage.stats.statementsFailed, file).toBe(deferred ? Number(deferred[1]) : 0);
    if (++n % 10 === 0) await new Promise((r) => setImmediate(r));
  }
}, 600_000);
