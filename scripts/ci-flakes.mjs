#!/usr/bin/env node
// Lists the tests that failed and then passed on a rerun of the same tree: CI runs with a second attempt, in which
// a job that failed on attempt 1 succeeded on the latest attempt. It samples the newest runs (one page of 100 by
// default, --pages N for more) instead of crawling the history, and reads the attempt-1 log of each such job.
// Read-only; needs the gh CLI. Each test is printed with the runs it flaked in and whether
// tests/harness/flaky-quarantine.json quarantines it.
//
// Usage: node scripts/ci-flakes.mjs [--pages N] [--repo owner/name]
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadQuarantine, quarantineEntry } from "./ci-quarantine.mjs";

/** The failed tests vitest's default reporter names in a job log: `{ file, name, fullName }`. */
export function failedTests(log) {
  const text = log.replaceAll(String.fromCharCode(27), "").replace(/\[[0-9;]*m/g, "");
  const found = new Map();
  for (const line of text.split("\n")) {
    const m = /^\S*\s*FAIL {2}(\S+\.test\.\w+) > (.+?)\s*$/.exec(line);
    if (!m) continue;
    const fullName = m[2];
    const name = fullName.split(" > ").at(-1);
    found.set(`${m[1]} > ${fullName}`, { file: m[1], name, fullName });
  }
  return [...found.values()];
}

function gh(path, repo) {
  return execFileSync("gh", ["api", "--allow-escape-sequences", `repos/${repo}/${path}`], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
}

function jobs(path, repo) {
  const all = [];
  for (let page = 1; ; page++) {
    const { jobs: batch } = JSON.parse(
      gh(`${path}${path.includes("?") ? "&" : "?"}per_page=50&page=${page}`, repo),
    );
    all.push(...batch);
    if (batch.length < 50) return all;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const arg = (name, fallback) => {
    const index = process.argv.indexOf(name);
    return index === -1 ? fallback : process.argv[index + 1];
  };
  const repo = arg("--repo", "vercel-labs/scriptc");
  const pages = Number(arg("--pages", "1"));
  const entries = loadQuarantine();
  const flakes = new Map();
  let reruns = 0;
  for (let page = 1; page <= pages; page++) {
    const { workflow_runs: runs } = JSON.parse(
      gh(`actions/workflows/ci.yml/runs?per_page=100&page=${page}`, repo),
    );
    for (const run of runs.filter((run) => run.run_attempt > 1)) {
      reruns++;
      const latest = new Map(
        jobs(`actions/runs/${run.id}/jobs?filter=latest`, repo).map((job) => [
          job.name,
          job.conclusion,
        ]),
      );
      for (const job of jobs(`actions/runs/${run.id}/attempts/1/jobs`, repo)) {
        if (job.conclusion !== "failure" || latest.get(job.name) !== "success") continue;
        for (const test of failedTests(gh(`actions/jobs/${job.id}/logs`, repo))) {
          const key = `${test.file} > ${test.name}`;
          const flake = flakes.get(key) ?? { ...test, seen: [] };
          flake.seen.push(
            `run ${run.id} job ${job.id} ${job.name} (${run.created_at.slice(0, 10)})`,
          );
          flakes.set(key, flake);
        }
      }
    }
  }
  console.log(
    `${reruns} reruns in the newest ${pages * 100} CI runs; tests that failed, then passed on a rerun:`,
  );
  for (const flake of [...flakes.values()].sort((a, b) => b.seen.length - a.seen.length)) {
    const entry = quarantineEntry(flake, entries);
    console.log(
      `${flake.seen.length}x ${flake.file} > ${flake.name}${entry ? ` [quarantined until ${entry.expires}]` : ""}`,
    );
    for (const seen of flake.seen) console.log(`    ${seen}`);
  }
}
