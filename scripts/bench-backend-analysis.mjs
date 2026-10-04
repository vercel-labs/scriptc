/* Isolate whole-module analysis from frontend/native toolchain timings.
 * Call chains and class hierarchies expose depth-dependent rescanning;
 * every measured run verifies the complete analysis result. */
import assert from "node:assert/strict";
import { parseArgs } from "node:util";
import { computeMayThrow } from "../packages/compiler/dist/backend/may-throw.js";
import { computeTraced } from "../packages/compiler/dist/backend/cycle-analysis.js";
import { F64, VOID } from "../packages/compiler/dist/ir/ir.js";

const { values } = parseArgs({ options: {
  iterations: { type: "string", default: "5" },
  sizes: { type: "string", default: "500,2000,4000,8000" },
  workloads: { type: "string", default: "may-throw,cycle-analysis,class-values-wide,class-values-deep" },
} });
const iterations = Number(values.iterations);
const sizes = values.sizes.split(",").map(Number);
const selected = values.workloads.split(",");
const names = ["may-throw", "cycle-analysis", "class-values-wide", "class-values-deep"];
assert.ok(Number.isInteger(iterations) && iterations >= 1 && iterations <= 100, "--iterations must be an integer between 1 and 100");
assert.ok(sizes.length >= 1 && sizes.length <= 16 && sizes.every((n) => Number.isInteger(n) && n >= 1 && n <= 100_000), "--sizes must contain 1–16 integers between 1 and 100000");
assert.ok(selected.length >= 1 && selected.every((name) => names.includes(name)), `--workloads must select from ${names.join(",")}`);
const loc = { file: "chain.ts", start: 0, end: 1 };
const value = { kind: "numLit", value: 1, type: F64, loc };
const results = [];
for (const size of sizes) {
  const functions = Array.from({ length: size }, (_, i) => ({
    name: `fn${i}`, params: [], locals: [], returnType: VOID, loc,
    body: [i === size - 1 ? { kind: "throw", value, loc }
      : { kind: "exprStmt", expr: { kind: "call", callee: `fn${i + 1}`, args: [], type: VOID, loc }, loc }],
  }));
  const mod = { irVersion: 13, sourceFile: loc.file, entry: "fn0", functions };
  const records = Array.from({ length: size }, (_, i) => ({
    id: `r${i}`, fields: [{ name: "next", type: i === size - 1 ? F64 : { kind: "record", shapeId: `r${i + 1}` } }],
  }));
  const graph = { ...mod, records };
  const workloads = [
    { name: "may-throw", run: () => computeMayThrow(mod), check: (answer) => {
      assert.equal(answer.indirect, false);
      assert.equal(answer.fns.size, size);
      for (const fn of functions) assert.ok(answer.fns.has(fn.name), fn.name);
    } },
    { name: "cycle-analysis", run: () => computeTraced(graph), check: (answer) => {
      assert.equal(answer.shapes.size, 0);
      assert.equal(answer.unions.size, 0);
    } },
  ];
  for (const deep of [false, true]) {
    const classes = Array.from({ length: size }, (_, i) => ({
      name: `C${i}`, ...(deep && i > 0 ? { base: `C${i - 1}` } : {}), fields: [], loc,
    })).reverse();
    const constructors = Array.from({ length: size }, (_, i) => ({
      name: `%C${i}.constructor`, params: [], locals: [], returnType: VOID, loc,
      body: (deep ? i === size - 1 : i % 2 === 0) ? [{ kind: "throw", value, loc }] : [],
    }));
    const factories = Array.from({ length: size }, (_, i) => ({
      name: `factory${i}`, params: [], locals: [], returnType: VOID, loc,
      body: [{ kind: "exprStmt", expr: {
        kind: "newValue", callee: { kind: "classRef", className: `C${i}`, type: { kind: "classval", className: `C${i}` }, loc },
        args: [], type: { kind: "object", className: `C${i}` }, loc,
      }, loc }],
    }));
    const hierarchy = { ...mod, classes, functions: [...factories, ...constructors] };
    workloads.push({ name: deep ? "class-values-deep" : "class-values-wide", run: () => computeMayThrow(hierarchy), check: (answer) => {
      assert.equal(answer.indirect, false);
      assert.equal(answer.fns.size, deep ? size + 1 : 2 * Math.ceil(size / 2));
      for (let i = 0; i < size; i++) {
        assert.equal(answer.fns.has(`factory${i}`), deep || i % 2 === 0, `factory${i}`);
        assert.equal(answer.fns.has(`%C${i}.constructor`), deep ? i === size - 1 : i % 2 === 0, `%C${i}.constructor`);
      }
    } });
  }
  for (const { name, run, check } of workloads) {
    if (!selected.includes(name)) continue;
    const samples = [];
    for (let i = -2; i < iterations; i++) {
      const start = performance.now();
      const answer = run();
      const ms = performance.now() - start;
      check(answer);
      if (i >= 0) samples.push(ms);
    }
    const sorted = [...samples].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    const median = sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
    results.push({ analysis: name, nodes: size, median_ms: median, samples_ms: samples });
    process.stderr.write(`${name} ${size}: ${median.toFixed(2)} ms\n`);
  }
}
console.log(JSON.stringify({ node: process.version, platform: process.platform, arch: process.arch, iterations, results }, null, 2));
