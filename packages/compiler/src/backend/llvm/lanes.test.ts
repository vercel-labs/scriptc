/* Lane loop emission (planning rules are in ir/lane-plans.test.ts, behavior is
 * in tests/harness/lane-loops.test.ts): a planned loop gets a vector entry
 * guard and a lane loop ahead of the scalar loop, the vector width comes from
 * the target, and a build without the plan flag emits neither. */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { compile } from "@scriptc/compiler";
import type { TargetCpu } from "../target-cpu.js";

const repoRoot = join(import.meta.dirname, "../../../..");
const cacheDir = join(repoRoot, "node_modules/.cache/scriptc-tests");
const saved = { plan: process.env["SCRIPTC_LANES_PLAN"], cache: process.env["SCRIPTC_NO_CACHE"] };

afterEach(() => {
  for (const [key, value] of [
    ["SCRIPTC_LANES_PLAN", saved.plan],
    ["SCRIPTC_NO_CACHE", saved.cache],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

interface EmitOptions {
  plan?: string;
  targetCpu?: TargetCpu;
}

async function emittedLlvm(
  name: string,
  source: string,
  options: EmitOptions = {},
): Promise<string> {
  if (options.plan === undefined) delete process.env["SCRIPTC_LANES_PLAN"];
  else process.env["SCRIPTC_LANES_PLAN"] = options.plan;
  process.env["SCRIPTC_NO_CACHE"] = "1";
  const key = createHash("sha256")
    .update(`${options.plan}\0${options.targetCpu}\0${source}`)
    .digest("hex")
    .slice(0, 16);
  const outDir = join(cacheDir, `lanes-${key}`);
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, `${name}.ts`);
  writeFileSync(file, source);
  const result = await compile(file, {
    outPath: join(outDir, name),
    outDir,
    backend: "llvm",
    ...(options.targetCpu === undefined ? {} : { targetCpu: options.targetCpu }),
  });
  if (!result.ok)
    throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
  return readFileSync(result.llvmPath, "utf8");
}

function body(llvm: string, name: string): string {
  const start = llvm.search(new RegExp(`^define internal [^\\n]*@${name}[.(]`, "m"));
  expect(start).toBeGreaterThanOrEqual(0);
  return llvm.slice(start, llvm.indexOf("\n}\n", start));
}

const SOURCE = `type Numbers = Uint8Array | Uint16Array;

function sum(a: Numbers): number {
  let t = 0;
  for (let i = 0; i < a.length; i++) t += a[i]!;
  return t;
}

function count(a: Numbers, limit: number): number {
  let c = 0;
  for (let i = 0; i < a.length; i++) if (a[i]! >= limit) c++;
  return c;
}

const a: Numbers = new Uint16Array(8);
console.log(sum(a), count(a, 3));
`;

test("a planned sum loads vectors and widens them to i64 lanes", async () => {
  const llvm = await emittedLlvm("sum", SOURCE, { plan: "sum" });
  const fn = body(llvm, "sc_bf_sum");
  // One arm per element type, both arm copies get a lane loop.
  expect(fn).toMatch(/load <4 x i8>, ptr [^,]+, align 1/);
  expect(fn).toMatch(/load <4 x i16>, ptr [^,]+, align 1/);
  expect(fn).toMatch(/zext <4 x i8> [^ ]+ to <4 x i64>/);
  expect(fn).toMatch(/zext <4 x i16> [^ ]+ to <4 x i64>/);
  expect(fn).toMatch(/add <4 x i64> [^ ]+, [^ ]+/);
  expect(fn).toMatch(/store <4 x i64> [^,]+, ptr %s\d+/);
});

test("the sum's entry guard bounds the element count by the element width", async () => {
  const llvm = await emittedLlvm("bounds", SOURCE, { plan: "sum" });
  const fn = body(llvm, "sc_bf_sum");
  // 2^45 elements of u8, 2^37 of u16: every partial sum stays below 2^53.
  expect(fn).toMatch(/icmp ult i64 [^,]+, 35184372088832/);
  expect(fn).toMatch(/icmp ult i64 [^,]+, 137438953472/);
  expect(fn).not.toMatch(/icmp ult i64 [^,]+, 2097152/);
});

test("the guard asks the run-time toggle and needs one whole vector", async () => {
  const llvm = await emittedLlvm("guard", SOURCE, { plan: "sum" });
  const fn = body(llvm, "sc_bf_sum");
  expect(fn).toMatch(/load i32, ptr @sc_lanes/);
  expect(fn).toMatch(/icmp ne i32 [^,]+, 0/);
  expect(fn).toMatch(/icmp uge i64 [^,]+, 4/);
  expect(fn).toMatch(/and i64 [^,]+, -4/);
});

test("the lane loop leaves the counter at its limit for the scalar loop", async () => {
  const llvm = await emittedLlvm("limit", SOURCE, { plan: "sum" });
  const fn = body(llvm, "sc_bf_sum");
  // The header loads the counter, the body advances it by one vector, and the
  // exit adds the lanes to the accumulator's slot and branches on.
  expect(fn).toMatch(/lane\.b\d*:/);
  expect(fn).toMatch(/add nuw i64 [^,]+, 4/);
  // The reduction reads the lane accumulator after the last group: the exit
  // block loads the slot, not a value from the loop's head.
  const exit = fn.match(/\nlane\.x\d*:\n([\s\S]*?)\n(?=[A-Za-z_.][\w.]*:|\})/)![1]!;
  expect(exit).toMatch(/load <4 x i64>, ptr %s\d+/);
  expect(exit.match(/extractelement <4 x i64>/g)).toHaveLength(4);
  expect(exit).toMatch(/sitofp i64 [^ ]+ to double/);
  expect(exit).toMatch(/fadd double %t\d+, %t\d+/);
  expect(exit).toMatch(/store double [^,]+, ptr %sc_l_t_0/);
});

test("a planned count compares lanes against a splat and widens the mask", async () => {
  const llvm = await emittedLlvm("count", SOURCE, { plan: "count" });
  const fn = body(llvm, "sc_bf_count");
  expect(fn).toMatch(/insertelement <4 x i8> poison, i8 [^,]+, i32 0/);
  expect(fn).toMatch(/shufflevector <4 x i8> [^,]+, <4 x i8> poison, <4 x i32> zeroinitializer/);
  expect(fn).toMatch(/insertelement <4 x i16> poison, i16 [^,]+, i32 0/);
  // u8 and u16 are unsigned, so the element test is unsigned.
  expect(fn).toMatch(/icmp uge <4 x i8> [^,]+, %t\d+/);
  expect(fn).toMatch(/icmp uge <4 x i16> [^,]+, %t\d+/);
  expect(fn).toMatch(/zext <4 x i1> [^ ]+ to <4 x i64>/);
});

test("a count's limit must be an exact integer in the element range", async () => {
  const llvm = await emittedLlvm("exact", SOURCE, { plan: "count" });
  const fn = body(llvm, "sc_bf_count");
  expect(fn).toMatch(/fcmp oge double [^,]+, 0\.0/);
  expect(fn).toMatch(/fcmp olt double [^,]+, 256\.0/);
  expect(fn).toMatch(/fcmp olt double [^,]+, 65536\.0/);
  expect(fn).toMatch(/fptosi double [^ ]+ to i64/);
  expect(fn).toMatch(/fcmp oeq double [^,]+, %[A-Za-z_.][\w.]*/);
});

test("the target's vector width decides the lane count", async () => {
  const v3 = await emittedLlvm("v3", SOURCE, { plan: "sum", targetCpu: "x86-64-v3" });
  expect(body(v3, "sc_bf_sum")).toMatch(/load <8 x i16>, ptr [^,]+, align 1/);
  const v4 = await emittedLlvm("v4", SOURCE, { plan: "sum", targetCpu: "x86-64-v4" });
  expect(body(v4, "sc_bf_sum")).toMatch(/load <16 x i16>, ptr [^,]+, align 1/);
  const v2 = await emittedLlvm("v2", SOURCE, { plan: "sum", targetCpu: "x86-64-v2" });
  expect(body(v2, "sc_bf_sum")).toMatch(/load <4 x i16>, ptr [^,]+, align 1/);
});

test("a build without the plan flag emits no lane code and no toggle", async () => {
  const llvm = await emittedLlvm("plain", SOURCE);
  expect(llvm).not.toMatch(/@sc_lanes/);
  expect(llvm).not.toMatch(/lane\./);
  expect(llvm).not.toMatch(/<(4|8|16) x i(8|16|32|64)>/);
});

test("only the shapes the plan flag names are lowered", async () => {
  const sums = await emittedLlvm("sum-only", SOURCE, { plan: "sum" });
  expect(body(sums, "sc_bf_sum")).toMatch(/load <4 x i16>/);
  expect(body(sums, "sc_bf_count")).not.toMatch(/load <4 x i16>/);
  const counts = await emittedLlvm("count-only", SOURCE, { plan: "count" });
  expect(body(counts, "sc_bf_sum")).not.toMatch(/load <4 x i16>/);
  expect(body(counts, "sc_bf_count")).toMatch(/load <4 x i16>/);
});

test("the toggle is read once at start-up, not per loop", async () => {
  const llvm = await emittedLlvm("toggle", SOURCE, { plan: "sum" });
  expect(llvm).toMatch(/@sc_lanes = internal global i32 1/);
  expect(llvm).toMatch(/define internal void @sc_lanes_init\(\)/);
  expect(llvm).toMatch(/declare ptr @getenv\(ptr\)/);
  expect(llvm).toMatch(/= call ptr @getenv\(ptr @sc_lanes_env\)/);
  expect(llvm.match(/call void @sc_lanes_init\(\)/g)).toHaveLength(1);
});
