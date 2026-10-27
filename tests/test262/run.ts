import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { shardSelect } from "../harness/shard.js";
import { runSource, type Outcome } from "./execute.js";
import {
  assertThrowsSource, directory, exclusion, harnessSource, propertyHelperSource, typedArrayHelperSource, matchesExpectation, matchesParseNegative, metadata, pin, sha256, snapshotDigest, summarize,
  testPaths, variants, vendorRoot, verifyVendor,
} from "./support.mjs";

async function main(): Promise<void> {
  const { values } = parseArgs({ options: {
    root: { type: "string" }, filter: { type: "string" }, limit: { type: "string" },
    report: { type: "string" }, journal: { type: "string" }, workers: { type: "string" }, backend: { type: "string", default: "default" },
    "compile-timeout": { type: "string" }, "runtime-timeout": { type: "string" },
    keep: { type: "boolean" }, list: { type: "boolean" }, help: { type: "boolean" },
  } });
  if (values.help) {
    console.log(`Static scriptc Test262 profile (dynamic engine disabled)
  pnpm test:test262                         run the vendored regression profile
  pnpm test:test262 --root PATH             survey a complete pinned snapshot
  --filter TEXT                            select test paths containing TEXT
  --limit N                                first N selected test files
  --workers N                              concurrent compiles (default 2)
  --backend default|llvm                    LLVM is the production backend
  --report PATH                            JSON report (default under node_modules/.cache)
  --journal PATH                           append each result as JSONL during the run
  --compile-timeout MS --runtime-timeout MS bound each compiler/program process
  --list                                   list variants and exclusions without compiling
  --keep                                   retain generated sources and native artifacts
SCRIPTC_SAN=1 enables sanitizers; SCRIPTC_TEST_SHARD=i/n partitions variants.
Adapted strict and sloppy scripts and source-matched syntax negatives can pass.
Other variants remain visible as exclusions.`);
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
  const workers = positive(values.workers ?? process.env.SCRIPTC_TEST_WORKERS, 2, "workers");
  const limit = positive(values.limit, Number.MAX_SAFE_INTEGER, "limit");
  const compileTimeoutMs = positive(values["compile-timeout"], 120_000, "compile-timeout");
  const runtimeTimeoutMs = positive(values["runtime-timeout"], 10_000, "runtime-timeout");
  const root = values.root ? resolve(values.root) : vendorRoot;
  if (values.root) {
    if (snapshotDigest(root) !== pin.snapshotSha256) throw new Error("Test262 snapshot differs from the pinned revision");
  } else verifyVendor();
  const allPaths: string[] = values.root ? testPaths(root) : pin.tests;
  const selected = allPaths.filter((path) => !values.filter || path.includes(values.filter)).slice(0, limit);
  if (!selected.length) throw new Error("no Test262 files matched the selection");
  const cases = selected.flatMap((path) => {
    const source = readFileSync(join(root, path), "utf8");
    const meta = metadata(source, path);
    return variants(meta).map((variant: string) => ({
      id: `${path}#${variant}`, path, variant, source, features: meta.features, includes: meta.includes, negative: meta.negative,
      asyncTest: meta.flags.includes("async"),
      exclusion: exclusion(source, meta, variant),
    }));
  });
  const shard = shardSelect(cases, (item) => item.id);
  if (values.list) {
    for (const item of shard) console.log(`${item.id}\t${item.exclusion ?? "run"}`);
    return;
  }
  const cache = join(directory, "../../node_modules/.cache/scriptc-test262");
  if (process.env.SCRIPTC_CACHE_DIR === undefined) {
    process.env.SCRIPTC_CACHE_DIR = join(cache, "cas");
    mkdirSync(process.env.SCRIPTC_CACHE_DIR, { recursive: true, mode: 0o700 });
  }
  process.env.SCRIPTC_TEST_STABLE_TOOLCHAIN ??= "1";
  const results: (Outcome & { id: string; path: string; variant: string; features: string[] })[] = [];
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
        });
      const outcome = item.negative?.phase === "parse" && matchesParseNegative(raw, item.source, item.variant)
        ? { status: "pass", phase: "compile" }
        : raw;
      const result = { id: item.id, path: item.path, variant: item.variant, features: item.features, ...outcome };
      if (journalPath) appendFileSync(journalPath, `${JSON.stringify(result)}\n`);
      results.push(result);
      if (outcome.status !== "excluded") console.log(`${outcome.status}\t${item.id}`);
    }
  }));
  results.sort((a, b) => a.id.localeCompare(b.id));
  const unexpected = results.filter((r) => r.status !== "excluded" &&
    (values.root ? r.status !== "pass" : !matchesExpectation(r.id, r)));
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
    shard: process.env.SCRIPTC_TEST_SHARD ?? null, shardVariants: shard.length,
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
    (!process.env.SCRIPTC_TEST_SHARD && !results.some((r) => r.status === "pass"))) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
