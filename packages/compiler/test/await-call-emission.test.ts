import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { compile } from "../src/index.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function emit(source: string): Promise<string> {
  const outDir = await mkdtemp(join(tmpdir(), "scriptc-await-call-"));
  directories.push(outDir);
  const entry = join(outDir, "main.ts");
  await writeFile(entry, source);
  const outPath = join(outDir, "program.ll");
  const result = await compile(entry, { entry, outDir, outPath, outputKind: "llvm" });
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

// Consuming an async generator keeps a body on its fiber: the await-call
// entries serve fiber bodies (stackless bodies suspend at their awaits).
const tick = `
async function* tick(): AsyncGenerator<number, void, undefined> {
  yield 0;
}
`;

const source = `${tick}
const cache = new Map<number, number>();
async function leaf(x: number): Promise<number> {
  const hit = cache.get(x);
  return hit ?? x + 1;
}
async function middle(x: number): Promise<number> {
  for await (const t of tick()) x += t;
  const y = await leaf(x);
  return y * 2;
}
async function main(): Promise<void> {
  const pending = leaf(1);
  let sum = await middle(2);
  for await (const t of tick()) sum += t;
  sum += await pending;
  console.log(sum);
}
void main();
`;

test("awaiting a direct call to a body that never suspends skips the promise", async () => {
  const llvm = await emit(source);
  expect(definition(llvm, "sc_f_middle")).toContain("call double @sc_aw_leaf(double");
  const entry = definition(llvm, "sc_aw_leaf");
  expect(entry).toContain("call double @sc_f_leaf(double %a0)");
  expect(entry).toContain("call void @scr_async_inline_exit(ptr %frame)");
  // The clean result takes the await's microtask turn and returns directly;
  // only the throw path builds the rejected promise.
  const clean = entry.slice(entry.indexOf("clean:"), entry.indexOf("thrown:"));
  expect(clean).toContain("call void @scr_await_hop()");
  expect(clean).not.toContain("@scr_promise_new");
  expect(entry.slice(entry.indexOf("thrown:"))).toContain("call void @scr_promise_reject_pending");
});

test("awaiting a direct call to a suspending body spawns and awaits in one call", async () => {
  const llvm = await emit(source);
  const main = definition(llvm, "sc_f_main");
  expect(main).toContain("call double @sc_aw_middle(double");
  // A call whose promise is kept keeps the promise-returning entry.
  expect(main).toContain("call ptr @sc_as_leaf(double");
  expect(definition(llvm, "sc_aw_middle")).toContain(
    "call double @scr_async_spawn_await_f64(ptr @sc_tr_middle, ptr %ap)",
  );
  // middle consumes an async generator, so it keeps its fiber.
  expect(definition(llvm, "sc_as_middle")).toContain("@scr_async_spawn(");
});

const adoptSource = `${tick}
async function leaf(x: number): Promise<number> {
  return x + 1;
}
async function slow(x: number): Promise<number> {
  await null;
  return x + 1;
}
async function relay(x: number): Promise<number> {
  for await (const t of tick()) x += t;
  return leaf(x);
}
async function relaySlow(x: number): Promise<number> {
  for await (const t of tick()) x += t;
  return slow(x);
}
async function guarded(x: number): Promise<number> {
  for await (const t of tick()) x += t;
  try {
    return leaf(x);
  } catch {
    return -1;
  } finally {
    console.log("finally");
  }
}
async function main(): Promise<void> {
  console.log((await relay(1)) + (await relaySlow(2)) + (await guarded(3)));
}
void main();
`;

test("returning a direct call adopts its promise one microtask turn later", async () => {
  const llvm = await emit(adoptSource);
  expect(definition(llvm, "sc_f_relay")).toContain("call double @sc_ad_leaf(double");
  // A body that never suspends: the adoption's then-job turn, then the
  // settled promise's own turn, still without materializing the promise.
  const entry = definition(llvm, "sc_ad_leaf");
  const exit = entry.indexOf("call void @scr_async_inline_exit(ptr %frame)");
  const hop = entry.indexOf("call void @scr_await_hop()");
  expect(exit).toBeGreaterThan(0);
  expect(hop).toBeGreaterThan(exit);
  expect(hop).toBeLessThan(entry.indexOf("clean:"));
  const clean = entry.slice(entry.indexOf("clean:"), entry.indexOf("thrown:"));
  expect(clean).toContain("call void @scr_await_hop()");
  expect(clean).not.toContain("@scr_promise_new");
  // A body that may suspend: its promise, the then-job turn, then the await.
  const slow = definition(llvm, "sc_ad_slow");
  expect(slow).toContain("call ptr @sc_as_slow(double %a0)");
  expect(slow.indexOf("call void @scr_await_hop()")).toBeLessThan(
    slow.indexOf("call double @scr_await_f64(ptr %p)"),
  );
});

test("a returned promise is adopted after finally regions, outside catch handlers", async () => {
  const llvm = await emit(adoptSource);
  const guarded = definition(llvm, "sc_f_guarded");
  // The call produces the promise; the finally body runs; only then the
  // adoption turn and the await.
  const call = guarded.indexOf("call ptr @sc_as_leaf(double");
  const log = guarded.indexOf("@scr_console_log", call);
  const hop = guarded.indexOf("call void @scr_await_hop()", call);
  expect(call).toBeGreaterThan(0);
  expect(log).toBeGreaterThan(call);
  expect(hop).toBeGreaterThan(log);
  expect(guarded.indexOf("call double @scr_await_f64(", hop)).toBeGreaterThan(hop);
});

const stacklessSource = `${tick}
async function leaf(x: number): Promise<number> {
  return x + 1;
}
async function slow(x: number): Promise<number> {
  await null;
  return x + 1;
}
async function middle(x: number): Promise<number> {
  const y = await slow(x);
  const z = await leaf(y);
  return y * 2 + z;
}
async function fibered(): Promise<number> {
  let s = 0;
  for await (const t of tick()) s += t;
  return s + (await middle(1));
}
async function main(): Promise<void> {
  console.log((await middle(2)) + (await fibered()));
}
void main();
`;

test("bodies that suspend only at their own awaits compile to stackless coroutines", async () => {
  const llvm = await emit(stacklessSource);
  const middle = definition(llvm, "sc_f_middle");
  expect(middle).toMatch(/^define internal double @sc_f_middle\(double [^)]*\) #1 /);
  // Each await prepares its continuation and suspends the coroutine, then
  // extracts the settled result; nothing parks the stack it runs on.
  expect(middle).toContain("call zeroext i1 @scr_coro_await_prepare(ptr");
  expect(middle).toContain("call double @scr_coro_await_f64(ptr");
  expect(middle).toContain("call ptr @sc_as_slow(double");
  // A callee that never suspends runs in place; the coroutine takes the
  // await's turn itself and awaits a rejected promise only on a throw.
  expect(middle).toContain("call double @sc_ai_leaf(double");
  const inline = definition(llvm, "sc_ai_leaf");
  expect(inline).toContain("call double @sc_f_leaf(double %a0)");
  expect(inline).toContain("call void @scr_async_inline_exit(ptr %frame)");
  expect(middle).toContain("call zeroext i1 @scr_coro_hop_prepare(ptr");
  expect(middle).toContain("call void @scr_promise_reject_pending(ptr");
  expect(middle).toContain("call void @scr_coro_async_finish(ptr");
  expect(middle).not.toContain("@sc_aw_");
  expect(middle).not.toContain("@scr_await_f64(");
  expect(definition(llvm, "sc_as_middle")).toContain("@scr_async_spawn_stackless(");
  expect(definition(llvm, "sc_f_main")).toContain("@scr_coro_await_prepare(");
  // A body that keeps its fiber still awaits a stackless callee in one
  // call: spawn, then the ordinary await of its promise.
  expect(definition(llvm, "sc_as_fibered")).toContain("@scr_async_spawn(");
  expect(definition(llvm, "sc_f_fibered")).toContain("call double @sc_aw_middle(double");
  const entry = definition(llvm, "sc_aw_middle");
  expect(entry).toContain("call ptr @sc_as_middle(double %a0)");
  expect(entry).toContain("call double @scr_await_f64(ptr %p)");
  // A body that never suspends stays fiberless.
  expect(definition(llvm, "sc_as_leaf")).toContain("@scr_async_inline_enter(");
});
