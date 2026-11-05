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

const STORE_SOURCE = `type Bytes3 = Uint8Array | Uint8ClampedArray | Int8Array;
type Halves = Uint16Array | Int16Array;

function fill(a: Bytes3, v: number): void {
  for (let i = 0; i < a.length; i++) a[i] = v;
}

function ramp(a: Bytes3): void {
  for (let i = 0; i < a.length; i++) a[i] = i * 2;
}

function shift(a: Halves): void {
  for (let i = 0; i < a.length; i++) a[i] = i + 70000;
}

function scale(a: Bytes3, k: number): void {
  for (let i = 0; i < a.length; i++) a[i] = a[i]! * k;
}

function narrow(a: Float32Array, k: number): void {
  for (let i = 0; i < a.length; i++) a[i] = a[i]! * k;
}

function clamp(a: Uint8ClampedArray, k: number): void {
  for (let i = 0; i < a.length; i++) a[i] = a[i]! * k;
}

function ratio(a: Bytes3, k: number): void {
  for (let i = 0; i < a.length; i++) a[i] = a[i]! / k;
}

function frac(a: Bytes3): void {
  for (let i = 0; i < a.length; i++) a[i] = a[i]! * 2.5;
}

function square(a: Bytes3, n: number): void {
  const k = n | 0;
  for (let i = 0; i < a.length; i++) a[i] = k * k;
}

const b = new Uint8Array(8);
fill(b, 1);
ramp(b);
scale(b, 2);
const h = new Uint16Array(8);
shift(h);
const f = new Float32Array(8);
narrow(f, 0.5);
const c = new Uint8ClampedArray(8);
clamp(c, 2);
ratio(b, 2);
frac(b);
square(b, 3);
console.log(b[0], h[0], f[0], c[0]);
`;

test("a planned store writes whole vectors and advances the counter", async () => {
  const llvm = await emittedLlvm("store", STORE_SOURCE, { plan: "store" });
  const fn = body(llvm, "sc_bf_fill");
  expect(fn).toMatch(/lane\.b\d*:/);
  expect(fn).toMatch(/store <4 x i8> [^,]+, ptr [^,]+, align 1/);
  expect(fn).toMatch(/add nuw i64 [^,]+, 4/);
  // The lane loop's exit falls through to the loop's own copies, which write
  // the elements the lanes left.
  expect(fn).toMatch(/store i8 [^,]+, ptr %\w+/);
});

test("an exact integer value is stored from its integer lanes", async () => {
  const llvm = await emittedLlvm("store-int", STORE_SOURCE, { plan: "store" });
  // `i * 2`: the counter and the literal are exact integers, so the lanes
  // multiply them and truncate to the element. The entry test bounds the
  // value below 2^53, where the integer and the double are the same number.
  const ramp = body(llvm, "sc_bf_ramp");
  expect(ramp).toMatch(/mul nsw <4 x i64> [^,]+, [^,]+/);
  expect(ramp).toMatch(/trunc <4 x i64> [^ ]+ to <4 x i8>/);
  expect(ramp).toMatch(/uitofp i64 [^ ]+ to double/);
  expect(ramp).toMatch(/fmul double %\w+, %\w+/);
  expect(ramp).toMatch(/fcmp olt double %\w+, 9007199254740992\.0/);
  // `i + 70000`: the sum is exact below the same bound.
  const shift = body(llvm, "sc_bf_shift");
  expect(shift).toMatch(/add nsw <4 x i64> [^,]+, [^,]+/);
  expect(shift).toMatch(/trunc <4 x i64> [^ ]+ to <4 x i16>/);
  expect(shift).toMatch(/fcmp olt double %\w+, 9007199254740992\.0/);
});

test("exact integer lanes whose product can pass 2^53 stay scalar", async () => {
  const llvm = await emittedLlvm("store-square", STORE_SOURCE, { plan: "store" });
  // `k * k`: both operands are exact integers, so the lanes compute the exact
  // product, while the scalar body above 2^53 stores the rounded double's low
  // bits. The lanes are kept only where the entry test bounds the product.
  const fn = body(llvm, "sc_bf_square");
  expect(fn).toMatch(/mul nsw <4 x i64> [^,]+, [^,]+/);
  expect(fn).toMatch(/fmul double %\w+, %\w+/);
  expect(fn).toMatch(/fcmp olt double %\w+, 9007199254740992\.0/);
});

test("an element's product takes ToUint32's direct lanes", async () => {
  const llvm = await emittedLlvm("store-scale", STORE_SOURCE, { plan: "store" });
  const fn = body(llvm, "sc_bf_scale");
  expect(fn).toMatch(/load <4 x i8>, ptr [^,]+, align 1/);
  expect(fn).toMatch(/fmul <4 x double> [^,]+, [^,]+/);
  // The entry test bounds the value by the element's widest and the factor's
  // magnitude; below 2^63 the lanes convert directly, with no per-vector
  // range test and no bit path.
  expect(fn).toMatch(/fneg double [^ ]+/);
  expect(fn).toMatch(/fmul double (?:128\.0, %\w+|%\w+, 128\.0)/);
  expect(fn).toMatch(/fcmp olt double [^,]+, 9223372036854775808\.0/);
  expect(fn).toMatch(/fptosi <4 x double> [^ ]+ to <4 x i64>/);
  expect(fn).toMatch(/trunc <4 x i64> [^ ]+ to <4 x i32>/);
  expect(fn).not.toMatch(/bitcast <4 x i1>/);
  expect(fn).not.toMatch(/shl <4 x i64>/);
});

test("a fractional literal keeps the double route", async () => {
  const llvm = await emittedLlvm("store-frac", STORE_SOURCE, { plan: "store" });
  const fn = body(llvm, "sc_bf_frac");
  expect(fn).toMatch(/fmul <4 x double> [^,]+, [^,]+/);
  // 2.5 is not an exact integer, so the value is not built from the integer
  // lanes; the lanes convert the product directly, below the entry bound.
  expect(fn).toMatch(/fptosi <4 x double> [^ ]+ to <4 x i64>/);
  expect(fn).not.toMatch(/i64 2\.5/);
});

test("a clamped element rounds and clamps the lanes", async () => {
  const llvm = await emittedLlvm("store-clamp", STORE_SOURCE, { plan: "store" });
  const fn = body(llvm, "sc_bf_clamp");
  expect(fn).toMatch(/fcmp ogt <4 x double> [^,]+, splat \(double 0\.0\)/);
  expect(fn).toMatch(/fcmp oge <4 x double> [^,]+, splat \(double 255\.0\)/);
  expect(fn).toMatch(/fadd <4 x double> [^,]+, splat \(double 4503599627370496\.0\)/);
  expect(fn).toMatch(/fptoui <4 x double> [^ ]+ to <4 x i32>/);
  expect(fn).toMatch(/trunc <4 x i32> [^ ]+ to <4 x i8>/);
});

test("a float store narrows the lanes and leaves the double alone", async () => {
  const llvm = await emittedLlvm("store-float", STORE_SOURCE, { plan: "store" });
  const narrow = body(llvm, "sc_bf_narrow");
  expect(narrow).toMatch(/fptrunc <4 x double> [^ ]+ to <4 x float>/);
  expect(narrow).toMatch(/store <4 x float> [^,]+, ptr [^,]+, align 1/);
  expect(narrow).not.toMatch(/fptosi/);
});

test("a store the lanes cannot reproduce keeps its scalar loop", async () => {
  const llvm = await emittedLlvm("store-refused", STORE_SOURCE, { plan: "store" });
  const fn = body(llvm, "sc_bf_ratio");
  expect(fn).not.toMatch(/lane\./);
  expect(fn).not.toMatch(/store <4 x i8>/);
});

test("the store shape alone does not lower a sum or a count", async () => {
  const llvm = await emittedLlvm("store-only", STORE_SOURCE, { plan: "store" });
  expect(body(llvm, "sc_bf_fill")).toMatch(/store <4 x i8>/);
  // No loop here reduces, so no lane accumulator is ever reduced out: the
  // reduction's vector load from the slot is the sum's and the count's mark.
  expect(llvm).not.toMatch(/load <4 x i64>, ptr %s/);
});

const DENSE_SOURCE = `function total(a: number[]): number {
  let t = 0;
  for (let i = 0; i < a.length; i++) t += a[i]!;
  return t;
}

function below(a: number[]): number {
  let c = 0;
  for (let i = 0; i < a.length; i++) if (a[i]! < 3) c++;
  // A non-integer write after the loop keeps the count in a double slot,
  // which is the slot the lane body folds into.
  c = Math.sqrt(c);
  return c;
}

function plain(a: number[]): number {
  let c = 0;
  for (let i = 0; i < a.length; i++) if (a[i]! < 3) c++;
  return c;
}

function ramp(dst: number[]): void {
  for (let i = 0; i < dst.length; i++) dst[i] = i * 2;
}

function fillIt(dst: number[], v: number): void {
  for (let i = 0; i < dst.length; i++) dst[i] = v;
}

function twice(dst: number[]): void {
  for (let i = 0; i < dst.length; i++) dst[i] = dst[i]! * 2;
}

function halves(dst: number[], k: number): void {
  for (let i = 0; i < dst.length; i++) dst[i] = dst[i]! / k;
}

const a = [1, 2, 3, 4, 5];
console.log(total(a), below(a), plain(a));
const d: number[] = new Array(8).fill(0);
fillIt(d, 3);
ramp(d);
twice(d);
halves(d, 2);
console.log(d.join(" "));
`;

test("a dense sum lanes the int32 slots of a number array", async () => {
  const llvm = await emittedLlvm("dense-sum", DENSE_SOURCE, { plan: "sum" });
  const fn = body(llvm, "sc_bf_total");
  // The storage kind is checked once: only int32 slots hold values an
  // integer sum is exact over.
  expect(fn).toMatch(/icmp eq i8 [^,]+, 7/);
  expect(fn).toMatch(/icmp ule i64 [^,]+, %t\d+/);
  expect(fn).toMatch(/icmp ult i64 [^,]+, 4194304/);
  expect(fn).toMatch(/load <4 x i32>, ptr [^,]+, align 1/);
  expect(fn).toMatch(/sext <4 x i32> [^ ]+ to <4 x i64>/);
});

test("a dense count compares int32 lanes against the exact limit", async () => {
  const llvm = await emittedLlvm("dense-count", DENSE_SOURCE, { plan: "count" });
  const fn = body(llvm, "sc_bf_below");
  expect(fn).toMatch(/icmp eq i8 [^,]+, 7/);
  expect(fn).toMatch(/fptosi double [^ ]+ to i64/);
  expect(fn).toMatch(/icmp slt <4 x i32> [^,]+, %t\d+/);
  expect(fn).toMatch(/zext <4 x i1> [^ ]+ to <4 x i64>/);
});

test("a count the integer locals hold keeps its scalar loop", async () => {
  const llvm = await emittedLlvm("dense-count-slot", DENSE_SOURCE, { plan: "count" });
  // The lane body stores a double count into the accumulator's slot; the
  // integer copies keep an int32 there, so their loops stay scalar.
  const fn = body(llvm, "sc_bf_plain");
  expect(fn).toMatch(/alloca i32 ; c/);
  expect(fn).not.toMatch(/lane\./);
});

test("a dense store writes whole vectors of doubles", async () => {
  const llvm = await emittedLlvm("dense-store", DENSE_SOURCE, { plan: "store" });
  const ramp = body(llvm, "sc_bf_ramp");
  // Double slots, checked once at the entry: the stored value is the
  // scalar body's own double.
  expect(ramp).toMatch(/icmp eq i8 [^,]+, 0/);
  expect(ramp).toMatch(/store <4 x double> [^,]+, ptr [^,]+, align 1/);
  expect(ramp).not.toMatch(/mul nsw <4 x i64>/);
  const twice = body(llvm, "sc_bf_twice");
  expect(twice).toMatch(/load <4 x double>, ptr [^,]+, align 1/);
  expect(twice).toMatch(/fmul <4 x double> [^,]+, [^,]+/);
  expect(twice).toMatch(/store <4 x double> [^,]+, ptr [^,]+, align 1/);
  // An invariant value is splatted from its own double slot.
  const fill = body(llvm, "sc_bf_fillIt");
  expect(fill).toMatch(/store <4 x double> [^,]+, ptr [^,]+, align 1/);
});

test("a dense store the lanes cannot reproduce keeps its scalar loop", async () => {
  const llvm = await emittedLlvm("dense-refused", DENSE_SOURCE, { plan: "store" });
  expect(body(llvm, "sc_bf_halves")).not.toMatch(/lane\./);
});

test("the toggle is read once at start-up, not per loop", async () => {
  const llvm = await emittedLlvm("toggle", SOURCE, { plan: "sum" });
  expect(llvm).toMatch(/@sc_lanes = internal global i32 1/);
  expect(llvm).toMatch(/define internal void @sc_lanes_init\(\)/);
  expect(llvm).toMatch(/declare ptr @getenv\(ptr\)/);
  expect(llvm).toMatch(/= call ptr @getenv\(ptr @sc_lanes_env\)/);
  expect(llvm.match(/call void @sc_lanes_init\(\)/g)).toHaveLength(1);
});
