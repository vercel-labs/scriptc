import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { shardSelect } from "../harness/shard.js";
import { runSource, type Outcome } from "./execute.js";
import { idPath, limitPerChapter, parseStatuses, readJournalIds, readPathList, resolveListedPaths } from "./select.mjs";
import {
  assertThrowsSource, directory, exclusion, harnessSource, propertyHelperSource, typedArrayHelperSource, matchesExpectation, matchesParseNegative, metadata, pin, sha256, snapshotDigest, summarize,
  testPaths, variants, vendorRoot, verifyVendor,
} from "./support.mjs";

async function main(): Promise<void> {
  const { values } = parseArgs({ options: {
    root: { type: "string" }, filter: { type: "string", multiple: true }, limit: { type: "string" }, "limit-per-chapter": { type: "string" },
    files: { type: "string" }, "from-journal": { type: "string" }, status: { type: "string", multiple: true },
    report: { type: "string" }, journal: { type: "string" }, workers: { type: "string" }, backend: { type: "string", default: "default" },
    "compile-timeout": { type: "string" }, "runtime-timeout": { type: "string" },
    keep: { type: "boolean" }, list: { type: "boolean" }, help: { type: "boolean" },
    islands: { type: "boolean" },
  } });
  if (values.help) {
    console.log(`Static scriptc Test262 profile (dynamic engine disabled)
  pnpm test:test262                         run the vendored regression profile
  pnpm test:test262 --root PATH             survey a complete pinned snapshot
  --filter TEXT                            select test paths containing TEXT (repeatable)
  --files PATH                             run exactly the test paths listed in PATH (one per line)
  --from-journal PATH [--status=a,b]       rerun the journal records with those outcomes
                                            (default: every unexpected outcome; pass and excluded never)
  --limit N                                first N selected test files
  --limit-per-chapter N                    up to N files per chapter, spread across the chapter
  --workers N                              concurrent compiles (default: available cores, at most 8)
  --backend default|llvm                    LLVM is the production backend
  --report PATH                            JSON report (default under node_modules/.cache)
  --journal PATH                           append each result as JSONL during the run
  --compile-timeout MS --runtime-timeout MS bound each compiler/program process
  --list                                   list variants and exclusions without compiling
  --keep                                   retain generated sources and native artifacts
  --islands                                measure sloppy variants an island can run
SCRIPTC_SAN=1 enables sanitizers; SCRIPTC_TEST_SHARD=i/n partitions variants.
Adapted strict and sloppy scripts and source-matched syntax negatives can pass.
Other variants remain visible as exclusions.

--islands lifts exactly the five host exclusions a Node island can express
(eval, Function, arguments, script-environment, globalThis) on sloppy
variants. A variant whose test module the compiler islands reports
island-pass/island-fail: Node proved the semantics, so it is not a native
pass and an island failure of such a variant is not a native regression.`);
    return;
  }
  function positive(value: string | undefined, fallback: number, name: string): number {
    if (value === undefined) return fallback;
    const n = Number(value);
    if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`${name} must be a positive integer`);
    return n;
  }
  if (!["default", "llvm"].includes(values.backend!)) throw new Error("invalid backend");
  const backend = values.backend as "default" | "llvm";
  // The runner's wall clock is spent in compile-worker processes, so the
  // machine's cores are the useful width. Capped at 8 to keep the per-worker
  // compiler memory bounded on large hosts.
  const workers = positive(values.workers ?? process.env.SCRIPTC_TEST_WORKERS, Math.min(8, availableParallelism()), "workers");
  const limit = positive(values.limit, Number.MAX_SAFE_INTEGER, "limit");
  const perChapterLimit = positive(values["limit-per-chapter"], Number.MAX_SAFE_INTEGER, "limit-per-chapter");
  const compileTimeoutMs = positive(values["compile-timeout"], 120_000, "compile-timeout");
  const runtimeTimeoutMs = positive(values["runtime-timeout"], 10_000, "runtime-timeout");
  const root = values.root ? resolve(values.root) : vendorRoot;
  if (values.root) {
    if (snapshotDigest(root) !== pin.snapshotSha256) throw new Error("Test262 snapshot differs from the pinned revision");
  } else verifyVendor();
  if (values.status && !values["from-journal"]) throw new Error("--status requires --from-journal");
  const statuses = parseStatuses(values.status);
  const allPaths: string[] = values.root ? testPaths(root) : pin.tests;
  const filters = values.filter ?? [];
  let selected = allPaths;
  if (values.files) {
    const listed = resolveListedPaths(readPathList(readFileSync(resolve(values.files), "utf8")), allPaths);
    selected = selected.filter((path) => listed.has(path));
  }
  if (filters.length) selected = selected.filter((path) => filters.some((filter) => path.includes(filter)));
  // A journal replay narrows the file inventory before any source is read: a
  // survey inventory is 53k files and a replay is usually a few hundred.
  const requested = values["from-journal"]
    ? readJournalIds(readFileSync(resolve(values["from-journal"]), "utf8"), statuses)
    : undefined;
  if (requested) {
    if (!requested.size) throw new Error(`no journal records match --status=${[...statuses].join(",")}`);
    const requestedPaths = new Set([...requested].map((id) => idPath(id)!));
    selected = selected.filter((path) => requestedPaths.has(path));
  }
  if (perChapterLimit !== Number.MAX_SAFE_INTEGER) selected = limitPerChapter(selected, perChapterLimit);
  selected = selected.slice(0, limit);
  if (!selected.length) throw new Error("no Test262 files matched the selection");
  const islands = values.islands === true;
  let cases = selected.flatMap((path) => {
    const source = readFileSync(join(root, path), "utf8");
    const meta = metadata(source, path);
    return variants(meta).map((variant: string) => {
      const exclusionReason = exclusion(source, meta, variant);
      // Only the island lane adds variants; a lifted variant is newly
      // measured, never a native result that could regress (decision S4).
      const islandExclusion = islands ? exclusion(source, meta, variant, true) : exclusionReason;
      return {
        id: `${path}#${variant}`, path, variant, source, features: meta.features, includes: meta.includes, negative: meta.negative,
        asyncTest: meta.flags.includes("async"),
        exclusion: islandExclusion,
        lifted: islandExclusion === undefined && exclusionReason !== undefined,
        liftedReason: islandExclusion === undefined ? exclusionReason : undefined,
      };
    });
  });
  if (requested) {
    const known = new Set(cases.map((item) => item.id));
    const missing = [...requested].filter((id) => !known.has(id));
    if (missing.length) {
      throw new Error(`--from-journal selected ${missing.length} variants that the path selection does not contain; first: ${missing.slice(0, 5).join(", ")}`);
    }
    cases = cases.filter((item) => requested.has(item.id));
  }
  const shard = shardSelect(cases, (item) => item.id);
  if (values.list) {
    for (const item of shard) {
      console.log(`${item.id}\t${item.exclusion ?? (item.lifted ? "run (island lane)" : "run")}`);
    }
    return;
  }
  const liftedCases = shard.filter((item) => item.lifted).length;
  const cache = join(directory, "../../node_modules/.cache/scriptc-test262");
  if (process.env.SCRIPTC_CACHE_DIR === undefined) {
    process.env.SCRIPTC_CACHE_DIR = join(cache, "cas");
    mkdirSync(process.env.SCRIPTC_CACHE_DIR, { recursive: true, mode: 0o700 });
  }
  process.env.SCRIPTC_TEST_STABLE_TOOLCHAIN ??= "1";
  const results: (Outcome & { id: string; path: string; variant: string; features: string[]; lifted: boolean })[] = [];
  const journalPath = values.journal ? resolve(values.journal) : undefined;
  if (journalPath) {
    mkdirSync(dirname(journalPath), { recursive: true });
    writeFileSync(journalPath, "", { flag: "wx" });
  }
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(workers, shard.length) }, async () => {
    for (;;) {
      const item = shard[next++];
      if (!item) return;
      const raw = item.exclusion
        ? { status: "excluded", reason: item.exclusion }
        : await runSource(item.source, {
          backend, sanitize: process.env.SCRIPTC_SAN === "1", compileTimeoutMs, runtimeTimeoutMs, keep: values.keep, asyncTest: item.asyncTest, includes: item.includes,
          variant: item.variant === "sloppy" ? "sloppy" : "strict",
          // A source-matched syntax negative stays the native compile
          // refusal it has always been; it never becomes an executable.
          islands: islands && item.negative === undefined,
          liftedReason: item.liftedReason,
        });
      const outcome = item.negative?.phase === "parse" && matchesParseNegative(raw, item.source, item.variant)
        ? { status: "pass", phase: "compile" }
        : raw;
      const result = { id: item.id, path: item.path, variant: item.variant, features: item.features, lifted: item.lifted, ...outcome };
      if (journalPath) appendFileSync(journalPath, `${JSON.stringify(result)}\n`);
      results.push(result);
      if (outcome.status !== "excluded") console.log(`${outcome.status}\t${item.id}`);
    }
  }));
  results.sort((a, b) => a.id.localeCompare(b.id));
  // A lifted variant is newly measured, so its result is data rather than a
  // native regression. Island passes satisfy the profile's pass expectation
  // but stay a separate status in the counts (decision S4).
  const unexpected = results.filter((r) => r.status !== "excluded" && !r.lifted &&
    (values.root ? r.status !== "pass" && r.status !== "island-pass" : !matchesExpectation(r.id, r)));
  const report = {
    schema: "scriptc.test262.v1",
    revision: pin.commit, snapshotSha256: pin.snapshotSha256,
    profile: "static-adapted-v6",
    harnessSha256: sha256(harnessSource + assertThrowsSource + propertyHelperSource + typedArrayHelperSource),
    requestedBackend: backend, sanitize: process.env.SCRIPTC_SAN === "1",
    host: `${process.platform}-${process.arch}`, node: process.version,
    compilerVersion: JSON.parse(readFileSync(join(directory, "../../packages/compiler/package.json"), "utf8")).version,
    scope: values.root ? "survey" : "regression-profile",
    upstreamTestFiles: pin.testFiles, availableTestFiles: allPaths.length,
    selectedTestFiles: selected.length, selectedVariants: cases.length,
    fromJournal: values["from-journal"] ? resolve(values["from-journal"]) : null,
    statuses: requested ? [...statuses].sort() : null,
    shard: process.env.SCRIPTC_TEST_SHARD ?? null, shardVariants: shard.length,
    islands, liftedVariants: liftedCases,
    unexpectedResults: unexpected.length,
    ...summarize(results), results,
  };
  const reportPath = resolve(values.report ?? join(cache, "report.json"));
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report.counts));
  console.log(`Report: ${reportPath}`);
  // Exclusions are visible but not failures. An all-excluded local selection
  // must not turn green; an empty distributed shard is legitimate.
  if (unexpected.length ||
    (!process.env.SCRIPTC_TEST_SHARD &&
      !results.some((r) => r.status === "pass" || r.status === "island-pass"))) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
