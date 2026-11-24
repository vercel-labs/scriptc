#!/usr/bin/env node
// The tests a merge queue group runs, as the queue_plan job reports them (.github/workflows/ci.yml). Today the
// queue's fast gate is every plain shard of the Linux suite and no separate smoke list: the merge queue stops
// running the sanitized, Effect, bootstrap and cross-platform lanes, which move to the push to main (the post
// tier). A later change swaps this selection for a subset of the shards plus a smoke corpus, and the workflow
// picks it up without edits: it reads plain_shards for the test matrix and smoke for the smoke job.
//
// usage: node scripts/ci/queue-tests.mjs [--github-output]
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Every plain shard of the Linux suite. The shards partition the corpus by case name (tests/harness/shard.ts), so
// their union runs every program exactly once.
export const PLAIN_SHARDS = Array.from({ length: 20 }, (_, index) => index + 1);

/** The queue's selection: the plain shards to run, and the smoke cases to run beside them (none yet). */
export function queueTests() {
  return { plainShards: [...PLAIN_SHARDS], smoke: [] };
}

function main() {
  const plan = queueTests();
  const outputs = [
    `plain_shards=${JSON.stringify(plan.plainShards)}`,
    `smoke=${JSON.stringify(plan.smoke)}`,
  ];
  if (process.argv.includes("--github-output") && process.env.GITHUB_OUTPUT)
    appendFileSync(process.env.GITHUB_OUTPUT, outputs.map((line) => `${line}\n`).join(""));
  for (const line of outputs) console.log(line);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
