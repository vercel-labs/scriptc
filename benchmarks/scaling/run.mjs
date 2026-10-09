#!/usr/bin/env node
// Scaling probe runner: builds each probe file with scriptc (release), runs every
// case at increasing sizes under the compiled binary and under Node, checks that
// stdout matches, and reports in-process time (stderr `T=<ms>`), the growth
// exponent between the two largest sizes, and the scriptc/Node ratio.
//
//   node benchmarks/scaling/run.mjs [--scriptc=<checkout>] [--only=file:case,...]
//        [--reps=3] [--timeout=20] [--json=out.json] [--strace]
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const here = dirname(fileURLToPath(import.meta.url));
const { values } = parseArgs({
  options: {
    scriptc: { type: "string", default: resolve(here, "../..") },
    only: { type: "string" },
    reps: { type: "string", default: "3" },
    timeout: { type: "string", default: "20" },
    json: { type: "string" },
    strace: { type: "boolean", default: false },
    "strace-only": { type: "boolean", default: false },
    "no-node": { type: "boolean", default: false },
    tag: { type: "string", default: "" },
  },
});

const S = [1e3, 1e4, 1e5, 1e6];
const SM = [1e3, 3e3, 1e4, 3e4];
const SQ = [250, 500, 1000, 2000];
// [file, case, sizes]
const CASES = [
  ...[
    "push", "pop", "shift", "queue", "splice-tail", "slice-small", "concat", "indexOf",
    "includes-str", "sort-num", "sort-sorted", "sort-str", "sort-obj", "reverse", "in-arr",
    "in-arr-str", "holes", "sparse", "spread", "map-filter-reduce", "array-from", "join",
    "flat", "lastIndexOf", "findIndex", "nested2d", "length-truncate",
  ].map((c) => ["arrays", c, S]),
  ["arrays", "unshift", SM],
  ["arrays", "splice-mid", [1e4, 1e5, 1e6]],
  ...[
    "concat-loop", "concat-num", "concat-read", "concat-then-scan", "template", "split-join",
    "split-chars", "replace-one", "replace-all", "replace-regex", "replace-fn", "slice-loop",
    "substring-loop", "indexOf-all", "indexOf-miss", "includes", "padStart", "repeat",
    "upper-lower", "charAt-loop", "index-loop", "for-of-chars", "nonascii-concat",
    "nonascii-index", "nonascii-slice", "str-compare", "trim", "lines-split", "num-to-string",
    "parse-nums", "starts-with", "locale-compare",
  ].map((c) => ["strings", c, S]),
  ["strings", "concat-prepend", SM],
  ...[
    "map-num", "map-str", "map-churn", "map-churn-first", "lru-touch", "set-churn",
    "set-iter-delete", "set-from-array", "obj-dict", "obj-dict-delete", "obj-num-keys",
    "object-keys", "spread-small", "object-assign", "from-entries", "group-by",
    "class-instances", "map-obj-keys",
  ].map((c) => ["collections", c, S]),
  ["collections", "spread-accumulate", SQ],
  ...[
    "json-wide", "json-indent", "json-nested", "json-many-small", "json-big-string", "closures",
    "closure-counter", "try-no-throw", "try-throw", "throw-deep", "finally", "regex-new",
    "regex-literal", "regex-exec-g", "match-all", "regex-split", "generator", "many-generators",
    "destructure", "date-new", "date-now", "perf-now", "date-format", "date-parse", "date-local",
    "math-random", "math-ops", "error-new",
  ].map((c) => ["misc", c, S]),
  ["misc", "json-deep", [3e3, 3e4, 3e5]],
  ...[
    "await-chain", "async-calls", "promise-all", "then-chain", "microtasks", "next-ticks",
    "console-log", "console-log-multi", "stdout-write", "console-error", "buffer-ops",
    "fs-big-read", "timers-cancel",
  ].map((c) => ["async-io", c, S]),
  ["async-io", "timers-seq", [100, 1000, 10000]],
  ["async-io", "timers-many", S],
  ["async-io", "immediates", [1e3, 1e4, 1e5]],
  ["async-io", "fs-small", [100, 1000, 10000]],
  ["async-io", "fs-append", [1000, 10000, 100000]],
];

const only = values.only ? new Set(values.only.split(",")) : undefined;
const selected = CASES.filter(
  ([f, c]) => !only || only.has(`${f}:${c}`) || only.has(f) || only.has(c),
);
const reps = Number(values.reps);
const timeoutMs = Number(values.timeout) * 1000;
const work = join(tmpdir(), `scaling-probes${values.tag ? "-" + values.tag : ""}`);
mkdirSync(work, { recursive: true });
const cli = join(values.scriptc, "packages/cli/dist/bootstrap.js");

const binaries = new Map();
for (const file of new Set(selected.map(([f]) => f))) {
  const bin = join(work, file);
  const t = Date.now();
  const r = spawnSync(
    process.execPath,
    [cli, "build", join(here, `${file}.ts`), "--optimization=release", "-o", bin],
    { encoding: "utf8" },
  );
  if (r.status !== 0) {
    console.error(`build ${file} failed:\n${r.stdout}\n${r.stderr}`);
    continue;
  }
  console.error(`built ${file} in ${Date.now() - t} ms`);
  binaries.set(file, bin);
}

function runOnce(cmd, args) {
  const t = process.hrtime.bigint();
  const r = spawnSync(cmd, args, {
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 1 << 30,
    env: { ...process.env, NODE_NO_WARNINGS: "1" },
  });
  const wall = Number(process.hrtime.bigint() - t) / 1e6;
  if (r.error || r.status !== 0) {
    return { error: r.error ? String(r.error.code ?? r.error) : `exit ${r.status}: ${r.stderr.slice(-300)}` };
  }
  const m = /T=([0-9.]+)\s*$/.exec(r.stderr);
  return {
    ms: m ? Number(m[1]) : NaN,
    wall,
    out: createHash("sha1").update(r.stdout).digest("hex"),
    tail: r.stdout.slice(-120),
  };
}
function measure(cmd, args) {
  let best;
  for (let i = 0; i < reps; i++) {
    const r = runOnce(cmd, args);
    if (r.error) return r;
    if (!best || r.ms < best.ms) best = r;
    if (r.ms > 3000) break;
  }
  return best;
}
function straceCount(bin, args) {
  const out = join(work, "strace.txt");
  const r = spawnSync("strace", ["-f", "-c", "-o", out, bin, ...args], {
    encoding: "utf8",
    timeout: timeoutMs * 3,
    maxBuffer: 1 << 30,
  });
  if (r.status !== 0 || !existsSync(out)) return undefined;
  const calls = {};
  let total = 0;
  for (const line of readFileSync(out, "utf8").split("\n")) {
    const m = /^\s*[0-9.]+\s+[0-9.]+\s+\d+\s+(\d+)\s+(?:\d+\s+)?(\w+)\s*$/.exec(line);
    if (m && m[2] !== "total") {
      calls[m[2]] = Number(m[1]);
      total += Number(m[1]);
    }
  }
  return { total, calls };
}

if (values["strace-only"]) {
  // Syscalls per operation: diff the strace -c counts of the two smallest
  // sizes so process startup cancels out.
  const out = [];
  for (const [file, name, sizes] of selected) {
    const bin = binaries.get(file);
    if (!bin) continue;
    const [n0, n1] = sizes;
    const a = straceCount(bin, [name, String(n0)]);
    const b = straceCount(bin, [name, String(n1)]);
    if (!a || !b) {
      console.log(`${file}:${name} strace failed`);
      continue;
    }
    const per = {};
    for (const [k, v] of Object.entries(b.calls)) {
      const d = (v - (a.calls[k] ?? 0)) / (n1 - n0);
      if (d > 0.001) per[k] = d;
    }
    const top = Object.entries(per)
      .sort((x, y) => y[1] - x[1])
      .slice(0, 6)
      .map(([k, v]) => `${k}=${v < 0.1 ? v.toFixed(4) : v.toFixed(2)}`)
      .join(" ");
    const perOp = (b.total - a.total) / (n1 - n0);
    console.log(`${file}:${name} n=${n0}->${n1} startup=${a.total} total=${b.total} per-op=${perOp.toFixed(4)} ${top}`);
    out.push({ file, case: name, n0, n1, a, b, per, perOp });
    if (values.json) writeFileSync(values.json, JSON.stringify(out, null, 1));
  }
  process.exit(0);
}

const results = [];
for (const [file, name, sizes] of selected) {
  const bin = binaries.get(file);
  if (!bin) continue;
  const rows = [];
  let scDead = false;
  let nodeDead = values["no-node"];
  for (const n of sizes) {
    const args = [name, String(n)];
    const sc = scDead ? { error: "skipped" } : measure(bin, args);
    const nd = nodeDead
      ? { error: "skipped" }
      : measure(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", join(here, `${file}.ts`), ...args]);
    if (sc.error) scDead = true;
    if (nd.error) nodeDead = true;
    const row = { n, sc_ms: sc.ms, sc_wall: sc.wall, node_ms: nd.ms, node_wall: nd.wall };
    if (sc.error) row.sc_error = sc.error;
    if (nd.error) row.node_error = nd.error;
    if (sc.out && nd.out && sc.out !== nd.out) row.mismatch = { sc: sc.tail, node: nd.tail };
    rows.push(row);
    if (scDead && nodeDead) break;
  }
  const ok = rows.filter((r) => Number.isFinite(r.sc_ms));
  const exp = (key) => {
    const v = rows.filter((r) => Number.isFinite(r[key]));
    if (v.length < 2) return undefined;
    const a = v[v.length - 2];
    const b = v[v.length - 1];
    return Math.log(Math.max(b[key], 0.05) / Math.max(a[key], 0.05)) / Math.log(b.n / a.n);
  };
  const last = ok[ok.length - 1];
  const entry = {
    file,
    case: name,
    rows,
    sc_exp: exp("sc_ms"),
    node_exp: exp("node_ms"),
    ratio: last && Number.isFinite(last.node_ms) ? last.sc_ms / Math.max(last.node_ms, 0.01) : undefined,
  };
  if (values.strace && last) entry.strace = { n: last.n, ...straceCount(bin, [name, String(last.n)]) };
  const flags = [];
  if (rows.some((r) => r.sc_error && !r.node_error)) flags.push("SC-FAIL");
  if (rows.some((r) => r.mismatch)) flags.push("MISMATCH");
  if (entry.sc_exp !== undefined && entry.sc_exp > 1.3 && last.sc_ms > 5 && entry.sc_exp > (entry.node_exp ?? 1) + 0.25)
    flags.push("SUPERLINEAR");
  if (entry.ratio !== undefined && entry.ratio > 3 && last.sc_ms > 2) flags.push(">3x");
  entry.flags = flags;
  results.push(entry);
  const fmt = (v) => (v === undefined || !Number.isFinite(v) ? "-" : v < 10 ? v.toFixed(2) : v.toFixed(0));
  const cells = rows
    .map((r) => `${r.n}:${r.sc_error ? "ERR" : fmt(r.sc_ms)}/${r.node_error ? "ERR" : fmt(r.node_ms)}`)
    .join(" ");
  console.log(
    `${file}:${name} ${cells} exp=${fmt(entry.sc_exp)}/${fmt(entry.node_exp)} ratio=${fmt(entry.ratio)} ${flags.join(",")}` +
      (entry.strace ? ` sys=${entry.strace.total}` : ""),
  );
  if (values.json) writeFileSync(values.json, JSON.stringify(results, null, 1));
}
if (values.json) writeFileSync(values.json, JSON.stringify(results, null, 1));
