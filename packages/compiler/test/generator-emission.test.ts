import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { compile } from "../src/index.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function emit(source: string, optimization?: "dev"): Promise<string> {
  const outDir = await mkdtemp(join(tmpdir(), "scriptc-generator-"));
  directories.push(outDir);
  const entry = join(outDir, "main.ts");
  await writeFile(entry, source);
  const outPath = join(outDir, "program.ll");
  const result = await compile(entry, {
    entry,
    outDir,
    outPath,
    outputKind: "llvm",
    ...(optimization !== undefined ? { optimization } : {}),
  });
  expect(result.ok, JSON.stringify(result)).toBe(true);
  return readFile(outPath, "utf8");
}

function definition(llvm: string, symbol: string): string {
  const match = new RegExp(`^define internal [^\\n]*@${symbol}(?:\\.i32)?\\([^]*?^}`, "m").exec(
    llvm,
  );
  expect(match, symbol).not.toBeNull();
  return match![0];
}

test("synchronous generators compile to stackless coroutines", async () => {
  const llvm = await emit(`
function* range(n: number): Generator<number, void, undefined> {
  for (let i = 0; i < n; i++) yield i;
}
let sum = 0;
for (const x of range(10)) sum += x;
console.log(sum);
`);
  expect(definition(llvm, "sc_f_range")).toMatch(
    /^define internal void @sc_f_range(?:\.i32)?\(double [^)]*\) #1 /,
  );
  expect(definition(llvm, "sc_f_range")).toContain("@llvm.coro.suspend(");
  // Number yields store into the generator's OUT slot inline, and the
  // for-of drive takes them back out inline.
  expect(definition(llvm, "sc_f_range")).toContain("getelementptr inbounds %ScrGenHead, ptr");
  expect(definition(llvm, "sc_f_range")).toMatch(
    /store i32 1, ptr %t\d+\n.*%ScrGenSlot.*i32 1\n\s*store double/,
  );
  expect(definition(llvm, "sc_f_range")).not.toContain("@scr_coro_yield_f64(");
  expect(llvm).not.toContain("@scr_gen_take_out_f64(");
  expect(llvm).toContain("%ScrGenHead = type { i64, ptr, ptr, i32, %ScrGenSlot }");
  expect(llvm).toContain("attributes #1 = { uwtable presplitcoroutine }");
  expect(definition(llvm, "sc_gs_range")).toContain("call ptr @scr_gen_new_stackless(");
  expect(llvm).not.toContain("@scr_gen_yield_f64(");
});

test("for-of, spread and yield* drive generators without result records", async () => {
  const llvm = await emit(`
function* leaves(depth: number): Generator<string, void, undefined> {
  if (depth === 0) {
    yield "leaf";
    return;
  }
  yield* leaves(depth - 1);
  yield* leaves(depth - 1);
}
let n = 0;
for (const s of leaves(3)) n += s.length;
console.log(n, [...leaves(2)].join(","));
`);
  expect(llvm).toContain("call zeroext i1 @scr_gen_step(");
  expect(llvm).toContain("call ptr @scr_gen_take_out_ref(");
  expect(definition(llvm, "sc_f_leaves")).toContain("call zeroext i1 @scr_gen_delegate_forward(");
  expect(llvm).not.toMatch(/^define internal ptr @sc_gres_/m);
});

test("yield* passes typed next values to the delegate without result records", async () => {
  const llvm = await emit(`
function* words(): Generator<number, string, string> {
  const a = yield 1;
  const b = yield 2;
  return a + b;
}
function* sentence(): Generator<number, string, string> {
  return yield* words();
}
const s = sentence();
s.next("x");
s.next("y");
console.log(s.next("z").value);
`);
  const body = definition(llvm, "sc_f_sentence");
  expect(body).toContain("call zeroext i1 @scr_gen_delegate_start(ptr %t");
  expect(body).toMatch(/@scr_gen_delegate_start\(ptr %t\d+, i32 3\)/);
  expect(body).toContain("call zeroext i1 @scr_gen_delegate_next(");
  expect(body).toContain("call zeroext i1 @scr_gen_delegate_forward(");
  expect(body).toContain("call ptr @scr_gen_take_out_ref(");
  expect(body).not.toContain("@scr_gen_take_in_");
  expect(body).not.toContain("@sc_gres_");
});

test("default any channels keep a typed yield and box only in result records", async () => {
  const llvm = await emit(`
function* nums(): Generator<number> {
  yield 1;
  yield 2;
}
let sum = 0;
for (const x of nums()) sum += x;
const r = nums().next();
console.log(sum, r.value);
`);
  expect(definition(llvm, "sc_f_nums")).toContain("getelementptr inbounds %ScrGenHead, ptr");
  expect(definition(llvm, "sc_f_nums")).not.toContain("@scr_coro_yield_f64(");
  expect(definition(llvm, "sc_f_nums")).not.toContain("@scr_gen_take_in_");
  expect(llvm).toMatch(/define internal ptr @sc_gres_\d+\(ptr %g\)[^\n]*\(dyn channel\)/);
});

test("async generators that suspend only at their own awaits and yields compile to stackless coroutines", async () => {
  const llvm = await emit(`
async function* ticks(n: number): AsyncGenerator<number, void, undefined> {
  for (let i = 0; i < n; i++) {
    await null;
    yield i;
  }
}
async function main(): Promise<void> {
  for await (const t of ticks(3)) console.log(t);
}
void main();
`);
  const body = definition(llvm, "sc_f_ticks");
  expect(body).toMatch(/^define internal void @sc_f_ticks(?:\.i32)?\(double [^)]*\) #1 /);
  // The await suspends the coroutine (one turn for a non-promise operand),
  // and the yield stores OUT before its own suspension.
  expect(body).toContain("call zeroext i1 @scr_coro_hop_prepare(ptr");
  expect(body).toContain("call void @scr_coro_yield_f64(ptr");
  expect(body).toContain("call void @scr_gen_coro_finish(ptr");
  expect(body).not.toContain("@scr_await_hop(");
  expect(body).not.toContain("@scr_gen_yield_f64(");
  expect(definition(llvm, "sc_gs_ticks")).toContain("call ptr @scr_async_gen_new_stackless(");
  // Consuming the generator does not park its consumer.
  expect(definition(llvm, "sc_as_main")).toContain("@scr_async_spawn_stackless(");
});

test("debug builds keep async generators on their fibers", async () => {
  const llvm = await emit(
    `
async function* ticks(n: number): AsyncGenerator<number, void, undefined> {
  for (let i = 0; i < n; i++) {
    await null;
    yield i;
  }
}
async function main(): Promise<void> {
  for await (const t of ticks(3)) console.log(t);
}
void main();
`,
    "dev",
  );
  expect(definition(llvm, "sc_gs_ticks")).toContain("call ptr @scr_async_gen_new(");
  expect(llvm).not.toContain("presplitcoroutine");
});

test("yield* over a number array walks the array natively", async () => {
  const llvm = await emit(`
function* flat(rows: number[][]): Generator<number, void, undefined> {
  for (const row of rows) yield* row;
}
let sum = 0;
for (const x of flat([[1, 2], [3]])) sum += x;
console.log(sum);
`);
  const body = definition(llvm, "sc_f_flat");
  expect(body).toContain("getelementptr inbounds %ScrGenSlot, ptr");
  expect(body).not.toContain("@scr_coro_yield_f64(");
  expect(body).not.toContain("@scr_dyn_iterator");
  expect(body).not.toContain("@scr_dyn_call");
  expect(body).not.toContain("@sc_gres_");
});
