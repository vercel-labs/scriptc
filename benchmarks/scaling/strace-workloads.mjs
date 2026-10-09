#!/usr/bin/env node
// strace -c every runtime benchmark workload built with a scriptc checkout and
// print its syscall totals (top calls first).
//   node benchmarks/scaling/strace-workloads.mjs --scriptc=<checkout> [--out=dir]
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const here = dirname(fileURLToPath(import.meta.url));
const suite = resolve(here, "../runtime");
const { values } = parseArgs({
  options: {
    scriptc: { type: "string", default: resolve(here, "../..") },
    out: { type: "string", default: "/tmp/strace-workloads" },
    json: { type: "string" },
  },
});
mkdirSync(values.out, { recursive: true });
const { workloads } = JSON.parse(readFileSync(join(suite, "workloads.json"), "utf8"));
const cli = join(values.scriptc, "packages/cli/dist/bootstrap.js");
// Same inputs as scripts/bench-runtime.mjs generates.
function input(kind) {
  const path = join(values.out, `${kind}.input`);
  const lines =
    kind === "log-summary"
      ? Array.from(
          { length: 300_000 },
          (_, i) =>
            `/route/${i % 37}?request=${i} ${i % 13 === 0 ? 500 : 200} ${i % 250} ${200 + (i % 4000)}`,
        )
      : Array.from({ length: 300_000 }, (_, i) =>
          ["sku-" + i, "category-" + (i % 17), "product " + i, i % 40, 199 + (i % 5000)].join("\t"),
        );
  writeFileSync(path, lines.join("\n") + "\n");
  return path;
}
const results = [];
for (const w of workloads) {
  const bin = join(values.out, w.name);
  const build = spawnSync(
    process.execPath,
    [cli, "build", join(suite, w.entry), "--optimization=release", "-o", bin],
    { encoding: "utf8", cwd: dirname(join(suite, w.entry)) },
  );
  if (build.status !== 0) {
    console.log(`${w.name}: build failed ${build.stderr.slice(0, 300)}`);
    continue;
  }
  const trace = join(values.out, `${w.name}.strace`);
  const args = (w.args ?? []).map((a) => (a === "{input}" ? input(w.input) : a));
  const r = spawnSync("strace", ["-f", "-c", "-o", trace, bin, ...args], {
    encoding: "utf8",
    maxBuffer: 1 << 30,
    cwd: dirname(join(suite, w.entry)),
  });
  const calls = {};
  let total = 0;
  for (const line of readFileSync(trace, "utf8").split("\n")) {
    const m = /^\s*[0-9.]+\s+[0-9.]+\s+\d+\s+(\d+)\s+(?:\d+\s+)?(\w+)\s*$/.exec(line);
    if (m && m[2] !== "total") {
      calls[m[2]] = Number(m[1]);
      total += Number(m[1]);
    }
  }
  const top = Object.entries(calls)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
  console.log(`${w.name} status=${r.status} total=${total} ${top}`);
  results.push({ name: w.name, status: r.status, total, calls });
}
if (values.json) writeFileSync(values.json, JSON.stringify(results, null, 1));
