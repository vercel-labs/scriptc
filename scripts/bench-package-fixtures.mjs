/* Published-package fixtures, built natively and measured two ways: callgrind
 * instruction counts of the plain build, and wall-time medians of interleaved
 * runs. With --attribute the fixtures are built a second time with every
 * inline-cache access routed through the runtime probe
 * (SCRIPTC_DEBUG_JS_IC_WAYS=0), and their profile is split by property entry
 * point, so the cost of untyped property access can be read per fixture and
 * per kind of access.
 *
 * Instruction counts are deterministic; wall times are not, so the two builds
 * of a fixture alternate and the median of each is reported. Every timed or
 * profiled run uses a fresh copy of the executable, because identical
 * binaries timed from different page-cache positions have differed by 8%. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { cpus } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const { values } = parseArgs({
  options: {
    fixtures: { type: "string" },
    runs: { type: "string", default: "9" },
    work: { type: "string" },
    cli: { type: "string" },
    attribute: { type: "boolean", default: false },
    "build-only": { type: "boolean", default: false },
    json: { type: "string" },
    help: { type: "boolean", default: false },
  },
});
if (values.help) {
  console.log(
    "Usage: pnpm bench:package-fixtures [--fixtures=a,b] [--runs=9] [--attribute] [--build-only] [--work=<dir>] [--cli=<script>] [--json=<file>]",
  );
  console.log(
    "Builds the published-package fixtures with --optimization speed, reports callgrind instruction counts, and reports wall-time medians of interleaved runs of the plain and, with --attribute, the all-probe build. --fixtures takes a comma-separated list of fixture names. --work sets the build directory (default node_modules/.cache/scriptc-package-fixtures). --cli sets the compiler entry (default packages/cli/dist/main.js run with node).",
  );
  process.exit(0);
}

/* The published-package fixtures: five effect programs,
 * two npm-static command-line programs, and six zod programs, each built the
 * way its suite builds it. */
const FIXTURES = [
  {
    name: "effect-core-all-record",
    entry: "tests/fixtures/effect/core-all-record.ts",
    args: ["--npm-static", "effect,fast-check,pure-rand"],
  },
  {
    name: "effect-core-loop",
    entry: "tests/fixtures/effect/core-loop.ts",
    args: ["--npm-static", "effect,fast-check,pure-rand"],
  },
  {
    name: "effect-config-provider",
    entry: "tests/fixtures/effect/config-provider.ts",
    args: ["--npm-static", "effect,fast-check,pure-rand"],
  },
  {
    name: "effect-data-collections",
    entry: "tests/fixtures/effect/data-collections.ts",
    args: ["--npm-static", "effect,fast-check,pure-rand"],
  },
  {
    name: "effect-data-hashmap",
    entry: "tests/fixtures/effect/data-hashmap.ts",
    args: ["--npm-static", "effect,fast-check,pure-rand"],
  },
  { name: "npm-static-effect-gen", entry: "tests/fixtures/npm-static/effect-gen-cli.ts", args: [] },
  { name: "npm-static-colors", entry: "tests/fixtures/npm-static/colors-cli.ts", args: [] },
  {
    name: "npm-static-array-helper",
    entry: "tests/fixtures/npm-static/array-helper-cli.ts",
    args: [],
  },
  { name: "npm-static-chainy", entry: "tests/fixtures/npm-static/chainy-cli.ts", args: [] },
  { name: "zod3-adoption", entry: "tests/fixtures/npm/cases/zod3-adoption/main.ts", args: [] },
  { name: "zod3", entry: "tests/fixtures/npm/cases/zod3/main.ts", args: [] },
  { name: "zod4-boundary", entry: "tests/fixtures/npm/cases/zod4-boundary/main.ts", args: [] },
  { name: "zod4-record", entry: "tests/fixtures/npm/cases/zod4-record/main.ts", args: [] },
];

const selected = values.fixtures ? new Set(values.fixtures.split(",").filter(Boolean)) : null;
for (const name of selected ?? [])
  assert.ok(
    FIXTURES.some((f) => f.name === name),
    `unknown fixture ${name}; known fixtures are ${FIXTURES.map((f) => f.name).join(", ")}`,
  );
const fixtures = FIXTURES.filter((f) => selected === null || selected.has(f.name));
const runs = Number(values.runs);
assert.ok(Number.isInteger(runs) && runs >= 3, "--runs must be an integer of at least 3");
const work = values.work
  ? resolve(values.work)
  : join(root, "node_modules/.cache/scriptc-package-fixtures");
const cli = values.cli ? resolve(values.cli) : join(root, "packages/cli/dist/main.js");
assert.ok(existsSync(cli), `compiler entry ${cli} does not exist; run pnpm -r build first`);
mkdirSync(work, { recursive: true });

/* ── building ───────────────────────────────────────────────────────────── */

const compilerEnv = { ...process.env };
delete compilerEnv.SCRIPTC_DEBUG_JS_IC_WAYS;

function build(fixture, { attribute }) {
  const out = join(work, attribute ? `${fixture.name}.all-probe` : fixture.name);
  const env = { ...compilerEnv };
  if (attribute) env.SCRIPTC_DEBUG_JS_IC_WAYS = "0";
  const started = Date.now();
  const result = spawnSync(
    process.execPath,
    [
      cli,
      "build",
      join(root, fixture.entry),
      "--optimization",
      "speed",
      "-o",
      out,
      ...fixture.args,
    ],
    { cwd: root, env, encoding: "utf8", maxBuffer: 64 << 20 },
  );
  if (result.status !== 0)
    throw new Error(
      `${fixture.name}${attribute ? " (all-probe)" : ""} failed to build:\n${result.stdout}\n${result.stderr}`,
    );
  return { out, seconds: (Date.now() - started) / 1000 };
}

/* A fresh copy per run: page-cache placement has moved identical binaries by
 * 8%, so no run shares its file with an earlier one. */
let copyId = 0;
function freshCopy(binary) {
  const copy = join(work, `.run-${process.pid}-${copyId++}`);
  copyFileSync(binary, copy);
  return copy;
}

function runOnce(binary, { callgrind = null } = {}) {
  const copy = freshCopy(binary);
  const started = process.hrtime.bigint();
  const command = callgrind
    ? ["valgrind", "--tool=callgrind", "--callgrind-out-file=" + callgrind, copy]
    : [copy];
  const result = spawnSync(command[0], command.slice(1), {
    cwd: work,
    encoding: "utf8",
    maxBuffer: 256 << 20,
  });
  const seconds = Number(process.hrtime.bigint() - started) / 1e9;
  rmSync(copy, { force: true });
  if (result.status !== 0)
    throw new Error(`${binary} exited with ${result.status}\n${result.stdout}\n${result.stderr}`);
  return { seconds, stdout: result.stdout };
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

/* ── callgrind ──────────────────────────────────────────────────────────── */

const FN = /^fn=\((\d+)\)(?:\s+(.*))?$/;
const CFN = /^cfn=\((\d+)\)(?:\s+(.*))?$/;

/* A callgrind profile as function records: self cost, and the cost each call
 * site spent in its callee. Valgrind records a call site's cost as the
 * callee's inclusive cost for those calls, so a function's inclusive cost is
 * its self cost plus its call sites' costs and needs no graph walk. */
function parseProfile(file) {
  const text = readFileSync(file, "utf8");
  const names = new Map();
  const self = new Map();
  const calls = [];
  let current = null;
  let callee = null;
  /* The call whose cost lines are still to come: its edge and how many cost
   * lines belong to it. */
  let pending = null;
  const name = (raw) => {
    const match = FN.exec(raw) ?? CFN.exec(raw);
    if (!match) return raw.trim();
    const [, id, label] = match;
    if (label) names.set(id, label.trim());
    return names.get(id) ?? `(${id})`;
  };
  const addSelf = (cost) => {
    if (current !== null) self.set(current, (self.get(current) ?? 0) + cost);
  };
  for (const line of text.split("\n")) {
    if (line.startsWith("fn=")) {
      current = name(line);
      if (!self.has(current)) self.set(current, 0);
      callee = null;
      pending = null;
      continue;
    }
    if (line.startsWith("cfn=")) {
      callee = name(line);
      pending = null;
      continue;
    }
    if (line.startsWith("calls=")) {
      /* `calls=<count> <position>...` carries no cost: the count and the
       * target positions only. The cost of those calls is the cost line(s)
       * that follow, one per position given. */
      pending = null;
      if (callee === null || current === null) continue;
      const fields = line.slice("calls=".length).trim().split(/\s+/).filter(Boolean);
      pending = {
        edge: { caller: current, callee, count: Number(fields[0]), cost: 0 },
        lines: Math.max(1, fields.length - 1),
      };
      continue;
    }
    /* A cost line is `<position> <cost...>`, where the position is `*`, a
     * relative `+N`/`-N`, or an absolute number. */
    const first = line.split(/\s+/)[0];
    if (first !== "*" && !/^[+-]?\d+$/.test(first)) continue;
    const cost = Number(line.trim().split(/\s+/).at(-1));
    if (!Number.isFinite(cost)) continue;
    if (pending !== null) {
      pending.edge.cost += cost;
      if (--pending.lines === 0) {
        calls.push(pending.edge);
        pending = null;
      }
      continue;
    }
    addSelf(cost);
  }
  const inclusive = new Map(self);
  const totals = new Map();
  for (const edge of calls) {
    inclusive.set(edge.caller, (inclusive.get(edge.caller) ?? 0) + edge.cost);
    totals.set(edge.callee, (totals.get(edge.callee) ?? 0) + edge.count);
  }
  return { self, inclusive, calls, totals };
}

/* Program code carries these prefixes; everything else is the runtime, the
 * standard library, the allocator or the collector. */
const PROGRAM = /^(?:sc_f_|sc_bf_|sc_df|sc_ldr_|sc_dm_)/;

const ENTRY_POINTS = [
  {
    kind: "read  inline cache",
    names: ["scr_js_load_probe", "scr_js_get_probe", "scr_js_get_probe_native"],
  },
  { kind: "write inline cache", names: ["scr_js_store_probe"] },
  { kind: "write literal member", names: ["scr_js_literal_probe"] },
  {
    kind: "read  dynamic",
    names: [
      "scr_js_keyed_probe",
      "scr_dyn_obj_read",
      "scr_dyn_obj_get",
      "scr_dyn_typed_ref_key_get",
      "scr_dyn_symbol_key_get",
    ],
  },
  { kind: "write dynamic", names: ["scr_dyn_key_set"] },
];

const belongs = (callee, entry) =>
  entry.names.some((prefix) => callee === prefix || callee.startsWith(`${prefix}.`));

/* Charges each entry point's call sites to the program when a program
 * function made them, at the callee's inclusive cost per call. */
function attribute(profile, instructions) {
  const perCall = new Map();
  for (const [callee, count] of profile.totals)
    if (count > 0 && profile.inclusive.has(callee))
      perCall.set(callee, profile.inclusive.get(callee) / count);
  const rows = [];
  for (const entry of ENTRY_POINTS) {
    let programCalls = 0;
    let otherCalls = 0;
    let cost = 0;
    for (const edge of profile.calls) {
      if (!belongs(edge.callee, entry)) continue;
      if (PROGRAM.test(edge.caller)) {
        programCalls += edge.count;
        cost += edge.count * (perCall.get(edge.callee) ?? 0);
      } else otherCalls += edge.count;
    }
    rows.push({ entry: entry.kind, programCalls, otherCalls, share: cost / instructions });
  }
  return rows;
}

/* ── measuring ──────────────────────────────────────────────────────────── */

const results = [];
for (const fixture of fixtures) {
  const plain = build(fixture, { attribute: false });
  const record = { name: fixture.name, buildSeconds: plain.seconds };
  process.stdout.write(`${fixture.name}: built in ${plain.seconds.toFixed(1)}s`);
  let probe = null;
  if (values.attribute) {
    probe = build(fixture, { attribute: true });
    record.probeBuildSeconds = probe.seconds;
  }
  if (!values["build-only"]) {
    const profileFile = join(work, `${fixture.name}.callgrind`);
    runOnce(plain.out, { callgrind: profileFile });
    record.instructions = summaryOf(profileFile);
    if (values.attribute) {
      const probeProfileFile = join(work, `${fixture.name}.all-probe.callgrind`);
      runOnce(probe.out, { callgrind: probeProfileFile });
      record.attribution = attribute(parseProfile(probeProfileFile), record.instructions);
    }
    const plainWall = [];
    const probeWall = [];
    for (let run = 0; run < runs; run++) {
      plainWall.push(runOnce(plain.out).seconds);
      if (probe) probeWall.push(runOnce(probe.out).seconds);
    }
    record.wallMedian = median(plainWall);
    record.wallMin = Math.min(...plainWall);
    record.wallMax = Math.max(...plainWall);
    if (probe) {
      record.probeWallMedian = median(probeWall);
      record.probeOverhead = record.probeWallMedian / record.wallMedian;
    }
    process.stdout.write(
      `  ${record.instructions.toLocaleString()} instructions, ${(record.wallMedian * 1000).toFixed(0)} ms`,
    );
  }
  results.push(record);
  process.stdout.write("\n");
}

/* The summary line is the profile's own total, which counts instructions
 * outside every function as well. */
function summaryOf(file) {
  const match = /^summary:\s+(\d+)/m.exec(readFileSync(file, "utf8"));
  return match ? Number(match[1]) : 0;
}

if (values.json) {
  const out = resolve(values.json);
  mkdirSync(dirname(out), { recursive: true });
  const document = {
    generatedAt: new Date().toISOString(),
    cpus: cpus().length,
    runs,
    fixtures: results,
  };
  writeFileSync(out, `${JSON.stringify(document, null, 2)}\n`);
}

if (!values["build-only"]) {
  const header = values.attribute
    ? "| fixture | instructions | wall ms | all-probe ms | probe x |"
    : "| fixture | instructions | wall ms |";
  console.log(`\n${header}`);
  console.log(values.attribute ? "| --- | ---: | ---: | ---: | ---: |" : "| --- | ---: | ---: |");
  for (const r of results) {
    const cells = [
      r.name,
      r.instructions.toLocaleString("en-US"),
      (r.wallMedian * 1000).toFixed(0),
    ];
    if (values.attribute)
      cells.push((r.probeWallMedian * 1000).toFixed(0), r.probeOverhead.toFixed(2));
    console.log(`| ${cells.join(" | ")} |`);
  }
  if (values.attribute) {
    console.log("\n## Program-facing property cost");
    console.log("\n| fixture | entry point | calls | other calls | share of instructions |");
    console.log("| --- | --- | ---: | ---: | ---: |");
    for (const r of results)
      for (const row of r.attribution)
        if (row.programCalls > 0)
          console.log(
            `| ${r.name} | ${row.entry} | ${row.programCalls.toLocaleString("en-US")} | ${row.otherCalls.toLocaleString("en-US")} | ${(row.share * 100).toFixed(2)}% |`,
          );
  }
}
