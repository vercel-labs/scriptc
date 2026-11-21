#!/usr/bin/env node
// E-1a harness: run the LLVM emitter's module rewrite chain twice, once in
// module order and once with the function order reversed, and compare the
// per-function results. Order independence is the property per-function
// parallel rewriting needs.
//
// usage: node emit-order.mjs <program.ts> [...]
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// A checkout may live under a path with spaces: the URL form keeps them
// escaped, so the CLI subprocess and the dynamic imports take file paths.
const root = fileURLToPath(new URL("..", import.meta.url));
const D = join(root, "packages/compiler/dist");
const imp = (p) => import(pathToFileURL(join(D, p)).href);
const { deserializeModule, encodeFunction } = await imp("ir/serialize.js");
const { IrNodeIndex } = await imp("ir/node-index.js");
const { unshareNodes } = await imp("ir/unshare.js");
const { rollLiteralTables } = await imp("ir/literal-tables.js");
const { deferClosedInitializers, initializerTrace } = await imp("backend/lazy-initializers.js");
const { mangleFunction } = await imp("backend/mangle.js");
const { observesStacks } = await imp("backend/stack-observations.js");
const { versionLoopBoundParameters } = await imp("ir/parameter-versions.js");
const { runPairedWhileLoopsAsFor } = await imp("ir/paired-while-loops.js");
const { dropUnwrittenPropertyBags } = await imp("ir/property-bags.js");
const { holdCharLocalsAsUnits } = await imp("ir/char-unit-locals.js");
const { freezeInitOnlyGlobals } = await imp("ir/init-only-globals.js");
const { hoistFinalFieldReads } = await imp("ir/field-values.js");
const { resolveSelfCaptures } = await imp("ir/self-captures.js");
const { copyStableCaptures } = await imp("ir/capture-values.js");
const { foldConstantGlobals } = await imp("ir/constant-globals.js");
const { inlineExpressionFunctions } = await imp("ir/expression-inlining.js");
const { inlineArraysApply, programLifetimeClassOf } = await imp("backend/llvm/inline-arrays.js");
const { inlineArrayReads, planInlineArrays } = await imp("ir/inline-arrays.js");
const { jamSaturatingLoops } = await imp("ir/saturating-loop-jams.js");
const { jamRuntimeCountLoops } = await imp("ir/runtime-jam-loops.js");
const { pairRowSums } = await imp("ir/row-pairs.js");
const { specializeTypedArguments } = await imp("ir/typed-argument-clones.js");
const { specializeConstantArrayLengths } = await imp("ir/constant-length-clones.js");
const { specializeNumericCalls } = await imp("ir/numeric-call-specialization.js");
const { specializeCallbackCalls } = await imp("ir/callback-specialization.js");
const { scalarizeNumericRecords, scalarizeLiteralResults } = await imp("ir/scalar-records.js");
const { addRecordResultEntries } = await imp("backend/llvm/record-results.js");
const { versionUnionArmLoops } = await imp("ir/union-arm-loops.js");

const OPTIONS = { pointerBits: 64, lowRegion: true };

function versionParameters(mod, nodes) {
  if (mod.lib !== undefined || observesStacks(mod, nodes)) return mod;
  return versionLoopBoundParameters(mod, mangleFunction, nodes);
}

function inlineArraysPass(options, mod) {
  if (!inlineArraysApply(mod, options)) return mod;
  return inlineArrayReads(mod, planInlineArrays(mod, programLifetimeClassOf(mod)));
}

function preChain(input) {
  const rolled = rollLiteralTables(unshareNodes(input));
  const rolledNodes = new IrNodeIndex(rolled);
  const mod = deferClosedInitializers(rolled, rolledNodes, initializerTrace(rolled));
  const nodes = mod === rolled ? rolledNodes : new IrNodeIndex(mod, rolledNodes);
  return { mod, nodes };
}

/** The rewrite chain as named steps over {mod, nodes}; every step uses the
 * one node index of the module the passes start from, as prepareModule does. */
function chainSteps(nodes) {
  return [
    ["paired-while-loops", (m) => runPairedWhileLoopsAsFor(m, nodes)],
    ["property-bags", (m) => dropUnwrittenPropertyBags(m, nodes)],
    ["char-unit-locals", (m) => holdCharLocalsAsUnits(m, nodes)],
    ["init-only-globals", (m) => freezeInitOnlyGlobals(m, nodes)],
    ["field-values", (m) => hoistFinalFieldReads(m, nodes)],
    ["self-captures", (m) => resolveSelfCaptures(m, nodes)],
    ["capture-values", (m) => copyStableCaptures(m, nodes)],
    ["constant-globals", (m) => foldConstantGlobals(m, nodes)],
    ["expression-inlining", (m) => inlineExpressionFunctions(m, nodes)],
    ["inline-arrays", (m) => inlineArraysPass(OPTIONS, m)],
    ["saturating-loop-jams", (m) => jamSaturatingLoops(m, nodes)],
    ["runtime-jam-loops", (m) => jamRuntimeCountLoops(m, nodes)],
    ["row-pairs", (m) => pairRowSums(m, nodes)],
    ["typed-arguments", (m) => specializeTypedArguments(m, mangleFunction, nodes)],
    ["constant-lengths", (m) => specializeConstantArrayLengths(m, mangleFunction, nodes)],
    ["numeric-calls", (m) => specializeNumericCalls(m, mangleFunction, nodes)],
    ["callback-calls", (m) => specializeCallbackCalls(m, mangleFunction, nodes)],
    ["scalar-records", (m) => scalarizeNumericRecords(m, nodes)],
    ["literal-results", (m) => scalarizeLiteralResults(m, nodes)],
    ["record-results", (m) => addRecordResultEntries(m, nodes)],
    ["parameter-versions", (m) => versionParameters(m, nodes)],
    ["union-arm-loops", (m) => versionUnionArmLoops(m, nodes)],
  ];
}

function parseModule(file) {
  return deserializeModule(readFileSync(file, "utf8"));
}

function moduleWide(mod) {
  const rest = { ...mod };
  delete rest.functions;
  return JSON.stringify(rest);
}

function compare(label, a, b) {
  const problems = [];
  const byName = (mod) => new Map(mod.functions.map((fn) => [fn.name, fn]));
  const fa = byName(a);
  const fb = byName(b);
  for (const [name, fn] of fa) {
    const other = fb.get(name);
    if (other === undefined) {
      problems.push(`missing ${name}`);
      continue;
    }
    if (encodeFunction(fn) !== encodeFunction(other)) problems.push(`function differs: ${name}`);
  }
  for (const name of fb.keys()) if (!fa.has(name)) problems.push(`extra ${name}`);
  if (moduleWide(a) !== moduleWide(b)) problems.push("module-wide fields differ");
  const ok = problems.length === 0;
  if (!ok) console.log(`  ${label}: ${problems.slice(0, 6).join("; ")}`);
  return ok;
}

const programs = process.argv.slice(2);
let failures = 0;
// The scratch IR of a program is its source in serialized form, so it lives in
// a private directory only this user can enter (mkdtemp creates it 0700) and
// is removed when the run ends, including when a program fails.
const work = mkdtempSync(join(tmpdir(), "scriptc-emit-order-"));
try {
  for (const program of programs) {
    const out = join(work, `input-${programs.indexOf(program)}.ir`);
    execFileSync(
      "node",
      [join(root, "packages/cli/dist/main.js"), "build", program, "--emit=ir", "-o", out],
      { stdio: "ignore" },
    );
    if (existsSync(out)) chmodSync(out, 0o600);
    const input = parseModule(out);
    const pre = preChain(input);
    const preRev = preChain(input);
    // Bisect: apply each step to both orders and compare after each. The
    // functions are reversed after preparation, not before: preparation
    // numbers the deferred initializer groups by function order, so reversing
    // the input would change those ids instead of the order under test.
    let normal = pre.mod;
    let reversed = { ...preRev.mod, functions: [...preRev.mod.functions].reverse() };
    let first = null;
    for (const [name, step] of chainSteps(pre.nodes)) {
      normal = step(normal);
      const reversedStep = chainSteps(preRev.nodes).find(([n]) => n === name)[1];
      reversed = reversedStep(reversed);
      if (!compare(`${program} after ${name}`, normal, reversed)) {
        first = first ?? name;
        break;
      }
    }
    console.log(
      `${first === null ? "ORDER-INDEPENDENT" : "FIRST DIVERGENT PASS: " + first} ${program}`,
    );
    if (first !== null) failures++;
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
process.exitCode = failures === 0 ? 0 : 1;
