/* Within-file partitioning for the corpus-driven harnesses.
 *
 * vitest's --shard is FILE-granular, and this suite's wall time is dominated
 * by a few monster files (differential.test.ts iterates the whole corpus
 * sequentially in one worker), so a naive file shard leaves one shard nearly
 * as slow as the whole suite. CI therefore sets SCRIPTC_TEST_SHARD="i/n"
 * alongside --shard=i/n, and every harness that globs a big case list runs
 * it through shardSelect below: small files distribute by file, monster
 * files split by case.
 *
 * The assignment hashes each case's stable NAME — never its list index — so
 * a program keeps its shard when the corpus grows around it (compile caches
 * stay warm across corpus additions) and, since the hash maps every key to
 * exactly one shard in [1..n], the union of the n shards runs every case
 * exactly once by construction (shard.test.ts pins the property). Unset =
 * everything: local runs are unchanged.
 */
import { createHash } from "node:crypto";
import { globSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Suite, Test, TestContext } from "vitest";

export interface ShardSpec {
  /** 1-based shard index. */
  index: number;
  count: number;
}

/** Parse a shard spec of the form "i/n" (1 <= i <= n). Undefined when the
 * variable is unset or empty; malformed values throw — a typo that ran
 * everything (or nothing) without an error would defeat the matrix. */
export function parseShardSpec(
  raw: string | undefined = process.env["SCRIPTC_TEST_SHARD"],
): ShardSpec | undefined {
  if (raw === undefined || raw === "") return undefined;
  const m = /^([1-9]\d*)\/([1-9]\d*)$/.exec(raw);
  if (!m) throw new Error(`SCRIPTC_TEST_SHARD must look like "2/3", got "${raw}"`);
  const index = Number(m[1]);
  const count = Number(m[2]);
  if (index > count) throw new Error(`SCRIPTC_TEST_SHARD index out of range: "${raw}"`);
  return { index, count };
}

/** The shard (1-based) a key belongs to among `count` shards: the first four
 * bytes of sha1(key) mod count — stable across runs, platforms, and corpus
 * growth. Total on its domain, so exactly one shard owns any key. */
export function shardOf(key: string, count: number): number {
  return (createHash("sha1").update(key).digest().readUInt32BE(0) % count) + 1;
}

/** The subset of `items` this shard owns. No spec (the local default) or a
 * single shard returns the whole list unchanged. */
export function shardSelect<T>(
  items: readonly T[],
  keyOf: (item: T) => string,
  spec: ShardSpec | undefined = parseShardSpec(),
): T[] {
  if (spec === undefined || spec.count === 1) return [...items];
  return items.filter((item) => shardOf(keyOf(item), spec.count) === spec.index);
}

/** Allocate expensive fixture lists by estimated cost. Longest cases go to
 * the lightest slice first, with key/index tie breakers so every process
 * independently constructs the same disjoint partition. Unlike hash-based
 * sharding, fixture additions can move existing cases between slices. */
export function balancedShardSelect<T>(
  items: readonly T[],
  keyOf: (item: T) => string,
  weightOf: (item: T) => number,
  spec: ShardSpec | undefined = parseShardSpec(),
): T[] {
  if (spec === undefined || spec.count === 1) return [...items];
  const keys = new Set<string>();
  const ranked = items
    .map((item, index) => {
      const key = keyOf(item);
      const weight = weightOf(item);
      if (keys.has(key)) throw new Error(`duplicate balanced shard key: ${key}`);
      if (!Number.isFinite(weight) || weight <= 0)
        throw new Error(`invalid balanced shard weight for ${key}: ${weight}`);
      keys.add(key);
      return { index, key, weight };
    })
    .sort((a, b) => b.weight - a.weight || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const loads = Array<number>(spec.count).fill(0);
  const owners = Array<number>(items.length);
  for (const item of ranked) {
    let slice = 0;
    for (let candidate = 1; candidate < loads.length; candidate++) {
      if (loads[candidate]! < loads[slice]!) slice = candidate;
    }
    loads[slice]! += item.weight;
    owners[item.index] = slice + 1;
  }
  return items.filter((_, index) => owners[index] === spec.index);
}

/** Measured milliseconds per corpus program and flavor: its differential plus llvm-differential case on a CI
 * runner. corpus-costs.json is the table scripts/ci-corpus-costs.mjs refreshes from CI logs. A change that adds
 * or remeasures a program records its costs in corpus-costs/<program>.json instead (`{ "plain": ms, "san": ms }`,
 * a directory program as corpus-costs/<dir>/main.ts.json), which overrides the table until the next refresh
 * folds it in. One file per program keeps changes that add programs from editing the same lines. */
export type CorpusCosts = { plain: Record<string, number>; san: Record<string, number> };
let corpusCostTable: CorpusCosts | undefined;

/** The per-program cost files: program key → its file's costs. Throws on a field other than plain/san or a
 * cost that is not a positive finite number. */
export function corpusCostFiles(
  dir: string = fileURLToPath(new URL("./corpus-costs", import.meta.url)),
): Map<string, Partial<Record<"plain" | "san", number>>> {
  const files = new Map<string, Partial<Record<"plain" | "san", number>>>();
  for (const rel of globSync("**/*.json", { cwd: dir })
    .map((path) => path.replaceAll("\\", "/"))
    .sort()) {
    const key = rel.slice(0, -".json".length);
    const entry = JSON.parse(readFileSync(join(dir, rel), "utf8")) as Record<string, unknown>;
    for (const [flavor, cost] of Object.entries(entry)) {
      if (
        (flavor !== "plain" && flavor !== "san") ||
        typeof cost !== "number" ||
        !Number.isFinite(cost) ||
        cost <= 0
      )
        throw new Error(
          `corpus-costs/${rel}: ${flavor} must be "plain" or "san" with a positive cost`,
        );
    }
    files.set(key, entry as Partial<Record<"plain" | "san", number>>);
  }
  return files;
}

/** corpus-costs.json with the per-program files applied. */
export function loadCorpusCosts(): CorpusCosts {
  const table = JSON.parse(
    readFileSync(new URL("./corpus-costs.json", import.meta.url), "utf8"),
  ) as CorpusCosts;
  for (const [key, entry] of corpusCostFiles()) {
    if (entry.plain !== undefined) table.plain[key] = entry.plain;
    if (entry.san !== undefined) table.san[key] = entry.san;
  }
  return table;
}

/** The corpus programs this shard owns, balanced by measured cost. differential.test.ts and
 * llvm-differential.test.ts both select with this, so a shard owns the same programs in both lanes and their
 * compile cache serves both. A program without a measurement weighs as much as the median measured one, so
 * new programs spread evenly; the union of the shards still runs every program exactly once. */
export function corpusSelect<T>(
  items: readonly T[],
  keyOf: (item: T) => string,
  sanitize: boolean,
  spec: ShardSpec | undefined = parseShardSpec(),
): T[] {
  corpusCostTable ??= loadCorpusCosts();
  const costs = sanitize ? corpusCostTable.san : corpusCostTable.plain;
  const known = Object.values(costs).sort((a, b) => a - b);
  const median = known.length === 0 ? 1 : known[Math.floor(known.length / 2)]!;
  return balancedShardSelect(items, keyOf, (item) => costs[keyOf(item)] ?? median, spec);
}

/** Suffix for describe titles so shard membership is visible in CI logs:
 * ", shard 2/3" under a spec, "" otherwise. */
export function shardSuffix(spec: ShardSpec | undefined = parseShardSpec()): string {
  return spec === undefined ? "" : `, shard ${spec.index}/${spec.count}`;
}

const ownedTests = new WeakMap<Suite, Set<Test>>();

/** For a suite of independent tests, called from beforeEach: skips the tests
 * this shard does not own. The suite's tests are balanced across the shards
 * by their measured cost (`costs`: milliseconds by test name; a test without
 * a measurement weighs as much as the median measured one), so every shard
 * runs a similar share and the union of the shards runs each test once. */
export function skipUnownedTest(
  context: TestContext,
  costs: Readonly<Record<string, number>>,
  spec: ShardSpec | undefined = parseShardSpec(),
): void {
  const suite = context.task.suite;
  if (spec === undefined || spec.count === 1 || suite === undefined) return;
  let owned = ownedTests.get(suite);
  if (owned === undefined) {
    const known = Object.values(costs).sort((a, b) => a - b);
    const median = known.length === 0 ? 1 : known[Math.floor(known.length / 2)]!;
    const tests = suite.tasks.filter((task): task is Test => task.type === "test");
    // test.each titles without their parameters repeat; later repeats get "#2", "#3"... as their key.
    const seen = new Map<string, number>();
    const keys = new Map(
      tests.map((test) => {
        const count = (seen.get(test.name) ?? 0) + 1;
        seen.set(test.name, count);
        return [test, count === 1 ? test.name : `${test.name} #${count}`];
      }),
    );
    owned = new Set(
      balancedShardSelect(
        tests,
        (test) => keys.get(test)!,
        (test) => Math.max(1, costs[test.name] ?? median),
        spec,
      ),
    );
    ownedTests.set(suite, owned);
  }
  if (!owned.has(context.task)) context.skip();
}
