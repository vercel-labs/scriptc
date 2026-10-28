import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

async function emitLlvm(source: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-speculative-loop-"));
  try {
    const entry = join(dir, "main.ts");
    const outPath = join(dir, "main.ll");
    await writeFile(entry, source);
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "llvm" });
    expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true);
    return await readFile(outPath, "utf8");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const source = `
class Point {
  x: number;
  w = 0;
  constructor(x: number) {
    this.x = x;
  }
}
function scaled(points: Point[], scale: number): number {
  let s = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!;
    p.w += 1;
    const k = p.x * scale;
    s += k * k;
  }
  return s;
}
console.log(scaled([new Point(1), new Point(2)], 2), scaled([new Point(1)], 0.5));
`;

function labels(fn: string): string[] {
  return [...fn.matchAll(/^([\w.]+):/gm)].map((m) => m[1]!);
}

test("a failed check finishes its iteration outside the ordinary copy", async () => {
  const llvm = await emitLlvm(source);
  const fn = /^define internal double @sc_bf_scaled\([^]*?^}/m.exec(llvm)?.[0] ?? "";
  const order = labels(fn);
  // Each speculative site emits its ordinary copy, its third copy and its
  // fast copy in that order.
  const slows = order.flatMap((l, i) => (l.startsWith("spec.slow") ? [i] : []));
  expect(slows.length).toBeGreaterThan(0);
  let resumes = 0;
  for (const slow of slows) {
    const next = (prefix: string): number =>
      order.findIndex((l, i) => i > slow && l.startsWith(prefix));
    const tail = next("spec.tail");
    const fast = next("spec.fast");
    expect(tail).toBeGreaterThan(slow);
    expect(fast).toBeGreaterThan(tail);
    // Every resume point of the site is in its third copy, between that
    // copy's start and the fast copy, so the ordinary copy has one entry.
    for (let i = slow + 1; i < fast; i++) {
      if (!order[i]!.startsWith("spec.resume")) continue;
      expect(i).toBeGreaterThan(tail);
      resumes++;
    }
    // The third copy's header leaves for the ordinary copy's header.
    const header = order[slow + 1]!;
    const third = fn.slice(fn.indexOf(`\n${order[tail]}:`), fn.indexOf(`\n${order[fast]}:`));
    expect(third).toContain(`br label %${header}`);
  }
  expect(resumes).toBe(order.filter((l) => l.startsWith("spec.resume")).length);
  expect(resumes).toBeGreaterThan(0);
});

test("a loop site stops entering its fast copy after repeated bails", async () => {
  const llvm = await emitLlvm(source);
  const site = /^(@sc_spec_bails_\d+) = internal global i8 0$/m.exec(llvm)?.[1];
  expect(site).toBeDefined();
  const fn = /^define internal double @sc_bf_scaled\([^]*?^}/m.exec(llvm)?.[0] ?? "";
  // The entry test reads the count, a bail adds one, and a completed fast
  // copy clears it.
  expect(fn).toMatch(
    new RegExp(
      `(%\\S+) = load atomic i8, ptr ${site} unordered, align 1\\n\\s*%\\S+ = icmp ult i8 \\1, 8`,
    ),
  );
  expect(fn).toMatch(new RegExp(`call i8 @llvm\\.uadd\\.sat\\.i8\\(i8 %\\S+, i8 1\\)`));
  expect(fn).toContain(`store atomic i8 0, ptr ${site} unordered, align 1`);
});

test("the slow copy of a dense-array loop has no speculative copy", async () => {
  const llvm = await emitLlvm(source);
  const fn = /^define internal double @sc_bf_scaled\([^]*?^}/m.exec(llvm)?.[0] ?? "";
  const order = labels(fn);
  const slow = order.findIndex((l) => l.startsWith("dense.loop.slow"));
  const fast = order.findIndex((l) => l.startsWith("dense.loop.fast"));
  expect(slow).toBeGreaterThanOrEqual(0);
  expect(fast).toBeGreaterThan(slow);
  // The slow copy runs when the guard fails; only the fast copy speculates.
  expect(order.slice(slow, fast).filter((l) => l.startsWith("spec."))).toEqual([]);
  expect(order.slice(fast).some((l) => l.startsWith("spec.fast"))).toBe(true);
  expect(llvm.match(/^@sc_spec_bails_\d+ = /gm)).toHaveLength(1);
});

test("the slow copy of a typed-array version keeps its proven integer loop", async () => {
  // The program can start a worker, so typed-array loops are versioned on
  // thread ownership.
  const llvm = await emitLlvm(`
import { Worker, isMainThread } from "node:worker_threads";
function count(bytes: Uint8Array): number {
  let lines = 0;
  for (let i = 0; i < bytes.length; i++) if (bytes[i] === 10) lines++;
  return lines;
}
if (isMainThread) {
  if (process.argv[2] === "spawn") new Worker(new URL(import.meta.url));
  console.log(count(new Uint8Array([10, 1, 10])));
}
`);
  const fn = /^define internal double @sc_bf_\w*count\([^]*?^}/m.exec(llvm)?.[0] ?? "";
  const order = labels(fn);
  const slow = order.findIndex((l) => l.startsWith("bytes.version.slow"));
  const fast = order.findIndex((l) => l.startsWith("bytes.version.fast"));
  expect(slow).toBeGreaterThanOrEqual(0);
  expect(fast).toBeGreaterThan(slow);
  expect(order.slice(slow, fast).some((l) => l.startsWith("integer.leave"))).toBe(true);
  expect(order.slice(fast).some((l) => l.startsWith("integer.leave"))).toBe(true);
});

test("the shared-storage copy of a typed-array version keeps its speculative copy", async () => {
  // In a program that can start a worker, the guard requires thread-owned
  // storage, so every view of a SharedArrayBuffer runs the checked copy.
  const llvm = await emitLlvm(`
import { Worker, isMainThread } from "node:worker_threads";
function trim(value: number, bits: number): number {
  return value - Math.floor(value / Math.pow(2, bits)) * Math.pow(2, bits);
}
function key(bytes: Uint8Array, bits: number): number {
  let k = 0;
  for (let i = 0; i < bytes.length; i++) k = trim(k, bits) * 4 + bytes[i]!;
  return k;
}
if (isMainThread) {
  if (process.argv[2] === "spawn") new Worker(new URL(import.meta.url));
  const shared = new Uint8Array(new SharedArrayBuffer(4));
  shared.set([1, 2, 3, 0]);
  console.log(key(shared, 6), key(new Uint8Array([3, 2, 1, 0]), 6));
}
`);
  const fn = /^define internal double @sc_bf_\w*key[\w.]*\([^]*?^}/m.exec(llvm)?.[0] ?? "";
  const order = labels(fn);
  const slow = order.findIndex((l) => l.startsWith("bytes.version.slow"));
  const fast = order.findIndex((l) => l.startsWith("bytes.version.fast"));
  expect(slow).toBeGreaterThanOrEqual(0);
  expect(fast).toBeGreaterThan(slow);
  expect(order.slice(slow, fast).some((l) => l.startsWith("spec.fast"))).toBe(true);
  expect(order.slice(fast).some((l) => l.startsWith("spec.fast"))).toBe(true);
});

test("a floor-mod by a power of two speculates as a mask and a product by one as a shift", async () => {
  const llvm = await emitLlvm(`
function trim(value: number, bits: number): number {
  return value - Math.floor(value / Math.pow(2, bits)) * Math.pow(2, bits);
}
function key(bytes: Uint8Array, bits: number): number {
  let k = 0;
  for (let i = 0; i < bytes.length; i++) k = trim(k, bits) * 4 + bytes[i]!;
  return k;
}
console.log(key(new Uint8Array([1, 2, 3, 0]), 6));
`);
  const fn = /^define internal double @sc_bf_\w*key[\w.]*\([^]*?^}/m.exec(llvm)?.[0] ?? "";
  const fast = fn.slice(fn.search(/^spec\.fast\d+:/m));
  expect(fast.length).toBeLessThan(fn.length);
  // trim(k, bits): the low `bits` bits; * 4: a shift by two.
  expect(fast).toMatch(/= sub i64 %\S+, 1\n\s+%\S+ = and i64 %\S+, %\S+\n/);
  expect(fast).toMatch(/= shl nsw i64 %\S+, 2\n/);
  // No floor division of k (an arithmetic shift of it) and no checked
  // multiply remain.
  expect(fast).not.toMatch(/ashr i64 %/);
  expect(fast).not.toContain("@llvm.smul.with.overflow.i64");
});

test("a speculative loop reads its views' header fields once, before its copies", async () => {
  // A view held by a const local or by a parameter is the same view in
  // every iteration. Its data pointer is read before the branch to the fast
  // copy, and no copy (ordinary, fast, or the one a failed check resumes
  // in) reads it again. `last` starts from a value no analysis bounds,
  // so the loops speculate on `l`.
  const llvm = await emitLlvm(`
let last = Number(process.argv[2] ?? "42");
function fill(array: ArrayBuffer, count: number): void {
  const buf = new Float64Array(array);
  let l = last;
  for (let i = 0; i < count; i++) {
    l = (l * 3877 + 29573) % 139968;
    buf[i] = l;
  }
  last = l;
}
function fillInto(buf: Float64Array, count: number): void {
  let l = last;
  for (let i = 0; i < count; i++) {
    l = (l * 3877 + 29573) % 139968;
    buf[i] = l;
  }
  last = l;
}
const array = new ArrayBuffer(8 * 16);
fill(array, 16);
const view = new Float64Array(8);
fillInto(view, 8);
console.log(new Float64Array(array)[15], view[7], last);
`);
  const dataReads = /getelementptr inbounds %ScrBytes, ptr %\w+, i64 0, i32 3$/gm;
  for (const name of ["fill", "fillInto"]) {
    const fn =
      new RegExp(`^define internal void @sc_bf_${name}(?:\\.i32)?\\([^]*?^}`, "m").exec(
        llvm,
      )?.[0] ?? "";
    const branch = /^ {2}br i1 %\w+, label %spec\.fast\d+, label %spec\.slow\d+$/m.exec(fn);
    expect(branch, name).not.toBeNull();
    const copies = fn.slice(branch!.index);
    expect(copies.match(dataReads), name).toBeNull();
    expect(fn.slice(0, branch!.index).match(dataReads)?.length, name).toBeGreaterThan(0);
  }
});
