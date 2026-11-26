#!/usr/bin/env node
/* --lib host-call microbenchmark runner. Builds the fixture library with
 * this checkout's compiler and runtime pack, links probe.c against it, and
 * reports ns per host call for the compiled `hb_run` loop and for the
 * direct C call in the same loop. `compare` turns two recorded runs into
 * the before/after interval the perf rules ask for.
 *
 *   node benchmarks/library-hostcall/run.mjs measure --out run.json [--calls N] [--reps R]
 *   node benchmarks/library-hostcall/run.mjs compare before.json after.json
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const fixtureDir = join(repoRoot, "benchmarks/library-hostcall");

/* A cached archive from a previous build of a different compiler tree would
 * silently measure that build, so the measurement never reads or writes the
 * build cache. */
process.env["SCRIPTC_CACHE_DIR"] = "";

const argv = process.argv.slice(2);
const command = argv[0];
const option = (name, fallback) => {
  const at = argv.indexOf(`--${name}`);
  return at >= 0 ? argv[at + 1] : fallback;
};

const flat = (file) => {
  const run = JSON.parse(readFileSync(file, "utf8"));
  return {
    profile: run.profile ?? "profile.json",
    calls: run.calls,
    reps: run.reps,
    lib: run.lib.map((ns) => ns / run.calls),
    c: run.c.map((ns) => ns / run.calls),
  };
};

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const variance = (xs) => {
  const m = mean(xs);
  return xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1);
};

/* Two-sided 95% Student t quantiles. Interpolating between the listed
 * degrees of freedom errs wide, which only makes an interval more
 * conservative. */
const T95 = [
  [1, 12.71], [2, 4.303], [3, 3.182], [4, 2.776], [5, 2.571], [6, 2.447], [7, 2.365],
  [8, 2.306], [9, 2.262], [10, 2.228], [11, 2.201], [12, 2.179], [13, 2.16], [14, 2.145],
  [15, 2.131], [16, 2.12], [17, 2.11], [18, 2.101], [19, 2.093], [20, 2.086], [25, 2.06],
  [30, 2.042], [40, 2.021], [60, 2.0], [120, 1.98], [Infinity, 1.96],
];
const t95 = (df) => {
  const row = T95.find(([d]) => d >= df);
  return row[1];
};

/** Welch's interval for mean(before) - mean(after). */
function welch(before, after) {
  const n1 = before.length;
  const n2 = after.length;
  const v1 = variance(before) / n1;
  const v2 = variance(after) / n2;
  const df = (v1 + v2) ** 2 / (v1 ** 2 / (n1 - 1) + v2 ** 2 / (n2 - 1));
  const diff = mean(before) - mean(after);
  const half = t95(df) * Math.sqrt(v1 + v2);
  return { diff, low: diff - half, high: diff + half, df };
}

const ns = (x) => x.toFixed(2);

if (command === "measure") {
  const out = option("out", join(repoRoot, "node_modules/.cache/hostcall-bench/run.json"));
  const calls = Number(option("calls", 5_000_000));
  const reps = Number(option("reps", 7));
  const profile = option("profile", "profile.json");
  const outDir = join(repoRoot, "node_modules/.cache/hostcall-bench", `build-${process.pid}`);
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  // The checkout's built compiler, without depending on how the workspace
  // links its packages into node_modules.
  const { compileLibrary } = await import(
    pathToFileURL(join(repoRoot, "packages/compiler/dist/index.js")).href
  );
  const result = await compileLibrary({
    profilePath: join(fixtureDir, profile),
    outDir,
  });
  if (!result.ok) {
    throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
  }

  const probe = join(outDir, "probe");
  execFileSync("clang", [
    "-O2",
    "-std=c11",
    join(fixtureDir, "probe.c"),
    result.archivePath,
    "-lm",
    "-o",
    probe,
  ]);

  const stdout = execFileSync(probe, [String(calls), String(reps)], { encoding: "utf8" });
  const lib = [];
  const c = [];
  for (const line of stdout.split("\n")) {
    const [kind, value] = line.trim().split(" ");
    if (kind === "lib") lib.push(Number(value));
    else if (kind === "c") c.push(Number(value));
  }
  if (lib.length !== reps || c.length !== reps) {
    throw new Error(`probe produced ${lib.length} lib and ${c.length} c samples:\n${stdout}`);
  }
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify({ profile, calls, reps, lib, c }, null, 2) + "\n");
  console.log(`${profile}: ${calls} host calls per repetition, ${reps} repetitions`);
  console.log(`lib  ${ns(mean(lib.map((v) => v / calls)))} ns/call`);
  console.log(`c    ${ns(mean(c.map((v) => v / calls)))} ns/call`);
  console.log(`wrote ${out}`);
} else if (command === "compare") {
  const before = flat(argv[1]);
  const after = flat(argv[2]);
  if (before.calls !== after.calls || before.profile !== after.profile) {
    throw new Error(
      `runs used ${before.calls} calls on ${before.profile} and ${after.calls} on ${after.profile}`,
    );
  }
  const lib = welch(before.lib, after.lib);
  const c = welch(before.c, after.c);
  const ratio = mean(before.lib) / mean(after.lib);
  console.log(`${before.profile}: ${before.reps} repetitions per side, ${before.calls} calls each`);
  console.log(
    `host call: ${ns(mean(before.lib))} -> ${ns(mean(after.lib))} ns/call ` +
      `(x${ratio.toFixed(2)}, delta ${ns(lib.diff)} ns [${ns(lib.low)}..${ns(lib.high)}], df ${lib.df.toFixed(1)})`,
  );
  console.log(`C baseline: ${ns(mean(before.c))} -> ${ns(mean(after.c))} ns/call`);
  console.log(
    lib.low > 0
      ? "verdict: win (the 95% interval excludes zero)"
      : "verdict: no reproducible win (the 95% interval includes zero)",
  );
  console.log(
    `c-baseline drift: ${ns(c.diff)} ns/call [${ns(c.low)}..${ns(c.high)}]`,
  );
} else {
  console.error(
    "usage: run.mjs measure --out FILE [--calls N] [--reps R] [--profile FILE] | compare BEFORE AFTER",
  );
  process.exit(2);
}
