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
  const outDir = await mkdtemp(join(tmpdir(), "scriptc-await-call-"));
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

// The await-call entries serve fiber bodies (stackless bodies suspend at
// their awaits). Debug builds keep every async body on its fiber, so the
// sources below that test them build with optimization "dev".
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
  const llvm = await emit(source, "dev");
  expect(definition(llvm, "sc_f_middle")).toContain("call double @sc_aw_leaf(double");
  const entry = definition(llvm, "sc_aw_leaf");
  expect(entry).toContain("call double @sc_f_leaf(double %a0)");
  // Nothing here enters an AsyncLocalStorage store or reads a stack, so the
  // body runs with a plain call (fiberlessFrames).
  expect(entry).not.toContain("@scr_async_inline_enter");
  // The clean result takes the await's microtask turn and returns directly;
  // only the throw path builds the rejected promise.
  const clean = entry.slice(entry.indexOf("clean:"), entry.indexOf("thrown:"));
  expect(clean).toContain("call void @scr_await_hop()");
  expect(clean).not.toContain("@scr_promise_new");
  expect(entry.slice(entry.indexOf("thrown:"))).toContain("call void @scr_promise_reject_pending");
});

test("awaiting a direct call to a suspending body spawns and awaits in one call", async () => {
  const llvm = await emit(source, "dev");
  const main = definition(llvm, "sc_f_main");
  expect(main).toContain("call double @sc_aw_middle(double");
  // A call whose promise is kept keeps the promise-returning entry.
  expect(main).toContain("call ptr @sc_as_leaf(double");
  expect(definition(llvm, "sc_aw_middle")).toContain(
    "call double @scr_async_spawn_await_f64(ptr @sc_tr_middle, ptr %ap)",
  );
  // The debug build keeps middle on its fiber.
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
  const llvm = await emit(adoptSource, "dev");
  expect(definition(llvm, "sc_f_relay")).toContain("call double @sc_ad_leaf(double");
  // A body that never suspends: the adoption's then-job turn, then the
  // settled promise's own turn, still without materializing the promise.
  const entry = definition(llvm, "sc_ad_leaf");
  const body = entry.indexOf("call double @sc_f_leaf(double %a0)");
  const hop = entry.indexOf("call void @scr_await_hop()");
  expect(body).toBeGreaterThan(0);
  expect(hop).toBeGreaterThan(body);
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
  const llvm = await emit(adoptSource, "dev");
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
async function fibered(): Promise<any> {
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
  // extracts the settled result; nothing parks the stack it runs on. A
  // stackless callee is awaited through its fiber record, without its
  // promise (emitCoroDirectAwait).
  expect(middle).toContain("call ptr @sc_dw_slow(double");
  expect(middle).toContain("call zeroext i1 @scr_coro_direct_prepare(ptr");
  expect(middle).toContain("call double @scr_coro_direct_f64(ptr");
  expect(middle).not.toContain("@sc_as_slow(");
  expect(definition(llvm, "sc_dw_slow")).toContain(
    "call ptr @scr_async_spawn_direct(ptr @sc_tr_slow",
  );
  // A callee that never suspends runs in place; the coroutine takes the
  // await's turn itself and awaits a rejected promise only on a throw.
  expect(middle).toContain("call double @sc_ai_leaf(double");
  const inline = definition(llvm, "sc_ai_leaf");
  expect(inline).toContain("call double @sc_f_leaf(double %a0)");
  expect(inline).not.toContain("@scr_async_inline_enter");
  expect(middle).toContain("call zeroext i1 @scr_coro_hop_prepare(ptr");
  expect(middle).toContain("call void @scr_promise_reject_pending(ptr");
  expect(middle).toContain("call void @scr_coro_async_finish(ptr");
  expect(middle).not.toContain("@sc_aw_");
  expect(middle).not.toContain("@scr_await_f64(");
  expect(definition(llvm, "sc_as_middle")).toContain("@scr_async_spawn_stackless(");
  expect(definition(llvm, "sc_f_main")).toContain("@scr_coro_await_prepare(");
  // A body with a dynamic result keeps its fiber, and still awaits a
  // stackless callee in one call: spawn, then the ordinary await of its
  // promise.
  expect(definition(llvm, "sc_as_fibered")).toContain("@scr_async_spawn(");
  expect(definition(llvm, "sc_f_fibered")).toContain("call double @sc_aw_middle(double");
  const entry = definition(llvm, "sc_aw_middle");
  expect(entry).toContain("call ptr @sc_as_middle(double %a0)");
  expect(entry).toContain("call double @scr_await_f64(ptr %p)");
  // A body that never suspends stays fiberless: its spawn wrapper calls the
  // body and settles a fresh promise.
  const spawn = definition(llvm, "sc_as_leaf");
  expect(spawn).toContain("call double @sc_f_leaf(double %a0)");
  expect(spawn).toContain("call ptr @scr_promise_new()");
  expect(spawn).not.toContain("@scr_async_spawn");
});

const framedSources = {
  // Entering a store needs no frame: the body runs in its caller's context,
  // as Node runs an async body's synchronous prefix.
  context: `
import { AsyncLocalStorage } from "node:async_hooks";
const store = new AsyncLocalStorage<string>();
async function leaf(x: number): Promise<number> {
  store.enterWith("leaf");
  return x + 1;
}`,
  // Reading a stack makes the frame isolate the Error.stack frame chain.
  stack: `
async function leaf(x: number): Promise<number> {
  if (x < 0) console.log(new Error("negative").stack);
  return x + 1;
}`,
};

test("fiberless bodies keep their frame only where it isolates a stack", async () => {
  for (const [name, prefix] of Object.entries(framedSources)) {
    const llvm = await emit(`${prefix}
async function slow(x: number): Promise<number> {
  await null;
  return x;
}
async function coroutine(x: number): Promise<number> {
  return (await slow(x)) + (await leaf(x));
}
async function* tick(): AsyncGenerator<number, void, undefined> {
  yield 0;
}
async function fibered(x: number): Promise<number> {
  for await (const t of tick()) x += t;
  return await leaf(x);
}
async function main(): Promise<void> {
  const pending = leaf(1);
  console.log((await coroutine(2)) + (await fibered(3)) + (await pending));
}
void main();
`);
    for (const symbol of ["sc_ai_leaf", "sc_aw_leaf", "sc_as_leaf"]) {
      const body = definition(llvm, symbol);
      if (name === "stack")
        expect(body, `${name} ${symbol}`).toContain(
          "call void @scr_async_inline_enter(ptr %frame)",
        );
      else expect(body, `${name} ${symbol}`).not.toContain("@scr_async_inline_enter");
    }
  }
});

const promiseAllSource = `
async function leaf(x: number): Promise<number> {
  return x + 1;
}
async function literal(x: number): Promise<number> {
  const all: number[] = await Promise.all([leaf(x), leaf(x + 1)]);
  return all[0]! + all[1]!;
}
async function local(x: number): Promise<number> {
  const ps = [leaf(x), leaf(x + 1), leaf(x + 2)];
  const all = await Promise.all(ps);
  return all.length;
}
async function reused(x: number): Promise<number> {
  const ps = [leaf(x)];
  const all = await Promise.all(ps);
  return all.length + ps.length;
}
async function main(): Promise<void> {
  console.log((await literal(1)) + (await local(2)) + (await reused(3)));
}
void main();
`;

test("a stackless body runs Promise.all of never-suspending calls in place", async () => {
  const llvm = await emit(promiseAllSource);
  for (const [symbol, calls] of [
    ["sc_f_literal", 2],
    ["sc_f_local", 3],
  ] as const) {
    const body = definition(llvm, symbol);
    // The entries run in place and fill the result array; one turn stands
    // for Promise.all's reaction jobs and one for the await.
    expect(body.match(/call double @sc_ai_leaf\(double/g)?.length, symbol).toBe(calls);
    expect(body.match(/call zeroext i1 @scr_coro_hop_prepare\(ptr/g)?.length, symbol).toBe(2);
    expect(body, symbol).toContain("call void @scr_promise_mark_handled(ptr");
    expect(body, symbol).not.toContain("@scr_promise_all(");
    expect(body, symbol).not.toContain("@sc_as_leaf(");
  }
  // A local the body reads again keeps its promises.
  const reused = definition(llvm, "sc_f_reused");
  expect(reused).toContain("call ptr @sc_as_leaf(double");
  expect(reused).toContain("@scr_promise_all(");
});

const directSource = `
async function slow(x: number): Promise<number> {
  await null;
  return x + 1;
}
async function direct(x: number): Promise<number> {
  return (await slow(x)) * 2;
}
async function adopting(x: number): Promise<number> {
  return slow(x);
}
async function kept(x: number): Promise<number> {
  const pending = slow(x);
  await null;
  return await pending;
}
async function main(): Promise<void> {
  console.log((await direct(1)) + (await adopting(2)) + (await kept(3)));
}
void main();
`;

test("a stackless body awaits a stackless callee's fiber record instead of its promise", async () => {
  const llvm = await emit(directSource);
  const direct = definition(llvm, "sc_f_direct");
  expect(direct).toContain("call ptr @sc_dw_slow(double");
  expect(direct).toContain("call zeroext i1 @scr_coro_direct_prepare(ptr");
  expect(direct).toContain("call double @scr_coro_direct_f64(ptr");
  expect(direct).not.toContain("@scr_coro_await_prepare(");
  // A returned call adopts the callee's promise, and a promise held in a
  // local is a value: both keep the promise.
  for (const symbol of ["sc_f_adopting", "sc_f_kept"]) {
    const body = definition(llvm, symbol);
    expect(body, symbol).toContain("call ptr @sc_as_slow(double");
    expect(body, symbol).not.toContain("@sc_dw_slow(");
  }
});
