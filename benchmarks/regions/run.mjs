#!/usr/bin/env node
// Lifetime-region benchmarks: builds each program in four variants and times
// interleaved runs, reporting medians of what the programs print.
//
//   node benchmarks/regions/run.mjs [--scriptc=<checkout>] [--baseline=<checkout>]
//        [--runs=7] [--only=name,...] [--json=out.json]
//
// Variants: `on` (ProgramLifetime classes, no regions: LifetimeRegion is
// replaced by a class whose run calls its callback), `off` (the same without
// `implements ProgramLifetime`), `region` (LifetimeRegion from
// @scriptc/experimental), `region-plain` (the region build run without
// constructing a region), and Node.js. `on` and `off` build with
// --baseline (default: --scriptc). Every variant must print the same result.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const here = dirname(fileURLToPath(import.meta.url));
const { values } = parseArgs({
  options: {
    scriptc: { type: "string", default: resolve(here, "../..") },
    baseline: { type: "string" },
    runs: { type: "string", default: "7" },
    only: { type: "string" },
    json: { type: "string" },
  },
});

const CONFIGS = [
  // DESIGN-style generations: per-file regions and a checker region.
  { name: "generations-edit", program: "generations.ts", args: ["200", "2000", "50", "edit"] },
  { name: "generations-all", program: "generations.ts", args: ["100", "2000", "50", "all"] },
  { name: "generations-one-shot", program: "generations.ts", args: ["800", "4000", "1", "edit"] },
  // A tokenizer, parser, binder and checker rebuilt in one region per build.
  { name: "compiler-watch", program: "compiler.ts", args: ["200", "60", "10"] },
  { name: "compiler-one-shot", program: "compiler.ts", args: ["400", "60", "1"] },
  // Per-file emit regions next to a large live heap of ordinary objects.
  { name: "emit-files", program: "emit.ts", args: ["400000", "200", "2000"] },
  // Concurrent async request handlers, one region per request across its awaits.
  { name: "requests-async", program: "requests.ts", args: ["4000", "16", "100"] },
];

const work = join(tmpdir(), `scriptc-region-bench-${process.pid}`);
mkdirSync(work, { recursive: true });
const stub = `class LifetimeRegion {\n  run<T>(fn: () => T): T {\n    return fn();\n  }\n  release(): void {}\n}`;

function build(checkout, source, out) {
  const r = spawnSync(process.execPath, [join(checkout, "packages/cli/dist/main.js"), "build", source, "-o", out], {
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(`build ${source} failed:\n${r.stderr}${r.stdout}`);
  return out;
}

const binaries = new Map();
function variants(program) {
  if (binaries.has(program)) return binaries.get(program);
  const src = readFileSync(join(here, program), "utf8");
  const on = join(here, `.${program}.on.ts`);
  const off = join(here, `.${program}.off.ts`);
  const withoutRegions = src.replace(/^import \{ LifetimeRegion \} from "@scriptc\/experimental";$/m, stub);
  writeFileSync(on, withoutRegions);
  writeFileSync(off, withoutRegions.replaceAll(" implements ProgramLifetime", ""));
  const baseline = values.baseline ?? values.scriptc;
  const v = {
    on: [build(baseline, on, join(work, `${program}-on`))],
    off: [build(baseline, off, join(work, `${program}-off`))],
    region: [build(values.scriptc, join(here, program), join(work, `${program}-region`))],
  };
  rmSync(on);
  rmSync(off);
  v["region-plain"] = v.region;
  v.node = [process.execPath, join(here, program)];
  binaries.set(program, v);
  return v;
}

const median = (xs) => [...xs].sort((a, b) => a - b)[xs.length >> 1];
const results = {};
for (const config of CONFIGS) {
  if (values.only && !values.only.split(",").includes(config.name)) continue;
  const v = variants(config.program);
  const samples = Object.fromEntries(Object.keys(v).map((k) => [k, []]));
  const outputs = new Map();
  for (let run = 0; run < Number(values.runs); run++) {
    const order = Object.keys(v).sort(() => Math.random() - 0.5);
    for (const name of order) {
      const [cmd, ...pre] = v[name];
      const args = name === "region-plain" ? [...config.args, "plain"] : config.args;
      const r = spawnSync(cmd, [...pre, ...args], { encoding: "utf8", cwd: here, maxBuffer: 1 << 26 });
      if (r.status !== 0) throw new Error(`${config.name} ${name} failed:\n${r.stderr}`);
      const lines = r.stdout.trim().split("\n");
      outputs.set(name, lines[0].replace(/ gen0 .*/, ""));
      const metrics = {};
      for (const [, key, value] of lines.at(-1).matchAll(/([a-z0-9-]+) ([0-9.]+) (?:ms|us|MB)/g))
        metrics[key] = Number(value);
      samples[name].push(metrics);
    }
  }
  if (new Set(outputs.values()).size !== 1) throw new Error(`${config.name}: outputs differ`);
  results[config.name] = Object.fromEntries(
    Object.entries(samples).map(([name, s]) => [
      name,
      Object.fromEntries(Object.keys(s[0]).map((k) => [k, median(s.map((m) => m[k]))])),
    ]),
  );
  console.log(config.name);
  console.table(results[config.name]);
}
if (values.json) writeFileSync(values.json, JSON.stringify(results, null, 2));
