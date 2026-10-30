/* Merge zero-cost gate shards into one verdict.
 *
 * A sharded gate runs scripts/zero-cost-gate.mjs several times over one
 * good-code set (--shard=i/n for the bench and corpus programs, the self
 * program in shard 1 or its own --set=self run), each with --json. This
 * script merges those reports: program verdicts and failures are
 * concatenated, and the compile-time verdicts and the "nothing was
 * compared" check are recomputed over every shard's rows. */
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { mergeReports, programLines } from "./zero-cost-compare.mjs";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    json: { type: "string" },
    quiet: { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
});
if (values.help || positionals.length === 0) {
  console.log(`Usage: node scripts/zero-cost-merge.mjs [--json=<file>] [--quiet] <shard.json>...

Merges the --json reports of zero-cost gate shards and prints one summary:
every program that is not identical, the compile-time verdicts and the
failures. --quiet prints only the summary and failures. --json writes the
merged report. Exit status: 0 when the merged gate passes, 1 when it fails.`);
  process.exit(values.help ? 0 : 2);
}

const reports = positionals.map((file) => JSON.parse(readFileSync(file, "utf8")));
const { report, timingLines } = mergeReports(reports);
if (!values.quiet)
  for (const entry of report.programs)
    if (entry.verdict !== "identical") for (const line of programLines(entry)) console.log(line);
for (const line of timingLines) console.log(line);
if (report.candidateSelf)
  console.log(
    report.candidateSelf.ok
      ? `self       candidate compiler source builds with the candidate (${(report.candidateSelf.buildMs / 1000).toFixed(2)}s)`
      : "self       candidate compiler source FAILS to build with the candidate",
  );
const cached = report.programs.filter((p) => p.cachedBaseline).length;
console.log(
  `zero-cost gate: ${report.verdict === "pass" ? "PASS" : "FAIL"} — ${Object.entries(report.counts)
    .map(([k, v]) => `${v} ${k}`)
    .join(", ")} over ${report.shards} shards (longest ${(report.elapsedMs / 1000).toFixed(2)}s` +
    `${cached ? `, ${cached} baselines from the cache` : ""})`,
);
for (const failure of report.failures) console.log(`  ${failure}`);
if (values.json) writeFileSync(values.json, JSON.stringify(report, null, 2) + "\n");
process.exit(report.verdict === "pass" ? 0 : 1);
