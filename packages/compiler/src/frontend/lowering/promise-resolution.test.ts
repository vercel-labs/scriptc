import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { compile } from "../../index.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function emit(source: string): Promise<string> {
  const outDir = await mkdtemp(join(tmpdir(), "scriptc-promise-resolution-"));
  directories.push(outDir);
  const entry = join(outDir, "main.ts");
  await writeFile(entry, source);
  const outPath = join(outDir, "program.ll");
  const result = await compile(entry, { outDir, outPath, outputKind: "llvm" });
  expect(result.ok, JSON.stringify(result)).toBe(true);
  return readFile(outPath, "utf8");
}

/** The calls that build a resolve function that runs the promise resolution
 * procedure. */
function resolvingCalls(llvm: string): number {
  return llvm.match(/call ptr @scr_make_resolve_dyn\(/g)?.length ?? 0;
}

const prelude = `
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
const emitter = new EventEmitter();
class Box { value = 1; }
class Lazy extends Box { then(done: (v: number) => void): void { done(this.value); } }
class Plain { value = 2; }
function untyped(): unknown { return 1; }
`;

test("an executor whose resolve values the types prove plain fulfils without a test", async () => {
  const llvm = await emit(`${prelude}
async function main(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 1));
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => process.nextTick(resolve));
  await new Promise((resolve) => queueMicrotask(() => resolve(null)));
  await new Promise((resolve) => { resolve(1); });
  await new Promise((resolve) => { resolve("text"); });
  await new Promise((resolve) => { resolve(undefined); });
  await new Promise((resolve) => { resolve({ ok: true }); });
  await new Promise((resolve) => { resolve([1, 2]); });
  await new Promise((resolve) => { resolve(new Plain()); });
  // A \`then\` member that cannot be called makes no thenable.
  await new Promise((resolve) => { resolve({ kind: "if", then: [1], else_: [2] }); });
  await new Promise((resolve) => { (resolve)(3); });
  // The listener of an event that carries nothing.
  const sink = new PassThrough();
  await new Promise((resolve) => { sink.on("finish", resolve); sink.end(); });
  await new Promise<void>((resolve) => setTimeout(resolve, 1));
  await new Promise<number>((resolve) => { resolve(4); });
  console.log(emitter.listenerCount("go"), untyped() === 1);
}
main();
`);
  expect(resolvingCalls(llvm)).toBe(0);
});

test("every other executor of an untyped promise asks the value", async () => {
  const cases = [
    // A value of unknown type, and a promise.
    "new Promise((resolve) => { resolve(untyped()); })",
    "new Promise((resolve) => { resolve(Promise.resolve(1)); })",
    // A record with a callable `then`.
    "new Promise((resolve) => { resolve({ then(done: (v: number) => void): void { done(1); } }); })",
    // An instance of a class with a subclass that declares `then`.
    "new Promise((resolve) => { resolve(new Box()); })",
    "new Promise((resolve) => { resolve(new Lazy()); })",
    // The resolve function leaves the executor, or goes where the callers'
    // arguments are unknown.
    "new Promise((resolve) => { const done = resolve; done(1); })",
    'new Promise((resolve) => { emitter.once("go", resolve); })',
    "new Promise((resolve) => { setTimeout(resolve, 1, untyped()); })",
    "new Promise((resolve) => { setImmediate(resolve, untyped()); })",
    "new Promise((resolve) => { [untyped()].forEach(resolve); })",
    // An executor that is a value.
    "new Promise(executor)",
  ];
  const llvm = await emit(`${prelude}
const executor = (resolve: (value: unknown) => void): void => { resolve(untyped()); };
const made: Promise<unknown>[] = [];
${cases.map((c) => `made.push(${c});`).join("\n")}
emitter.emit("go", 1);
console.log(made.length);
`);
  expect(resolvingCalls(llvm)).toBe(cases.length);
});

test("Promise.withResolvers of an untyped promise asks the value", async () => {
  const typed = await emit(`
const w = Promise.withResolvers<number>();
w.resolve(1);
w.promise.then((v) => { console.log(v); });
`);
  expect(resolvingCalls(typed)).toBe(0);
  const untyped = await emit(`
const w = Promise.withResolvers<unknown>();
w.resolve(1);
w.promise.then((v) => { console.log(String(v)); });
`);
  expect(resolvingCalls(untyped)).toBe(1);
});

/** The typed promises whose resolve function adopts a promise it is given:
 * each runs its executor through the resolution-aware entry. */
function adoptingExecutors(llvm: string): number {
  return llvm.match(/call void @scr_promise_run_executor_dyn\(/g)?.length ?? 0;
}

const typedPrelude = `
import { EventEmitter } from "node:events";
const emitter = new EventEmitter();
interface Box { a: number }
function maybe(now: boolean): number | Promise<number> { return now ? 1 : Promise.resolve(2); }
function later(): Promise<number> { return Promise.resolve(3); }
function settle(done: (value: number | Promise<number>) => void): void { done(later()); }
function settlePlain(done: (value: number) => void): void { done(4); }
let stored: ((value: number | Promise<number>) => void) | undefined;
let exact: (value: number | Promise<number>) => void = () => {};
let plain: (value: number) => void = () => {};
`;

test("a typed executor whose resolve values are plain keeps the fulfilling closure", async () => {
  const llvm = await emit(`${typedPrelude}
const made: Promise<unknown>[] = [];
made.push(new Promise<number>((resolve) => { resolve(1); }));
made.push(new Promise<number>((resolve, reject) => { if (made.length > 99) reject(new Error("x")); else resolve(1); }));
made.push(new Promise<string>((resolve) => { resolve("text"); }));
made.push(new Promise<Box>((resolve) => { resolve({ a: 1 }); }));
made.push(new Promise<void>((resolve) => { resolve(); }));
made.push(new Promise<void>((resolve) => setTimeout(resolve, 1)));
made.push(new Promise<number>((resolve) => { setTimeout(resolve, 1, 5); }));
made.push(new Promise<number>((resolve) => { process.nextTick(resolve, 5); }));
made.push(new Promise<number>((resolve) => { queueMicrotask(() => resolve(6)); }));
made.push(new Promise<number>((resolve) => { later().then(resolve); }));
made.push(new Promise<number>((resolve) => { plain = resolve; }));
made.push(new Promise<number>((resolve) => { settlePlain(resolve); }));
made.push(new Promise<number>((resolve) => { emitter.once("go", resolve); }));
made.push(new Promise<number>((resolve) => { const done = resolve; done(7); }));
plain(8);
emitter.emit("go", 9);
console.log(made.length, maybe(true) === 1, stored === undefined, exact.length);
`);
  expect(adoptingExecutors(llvm)).toBe(0);
  expect(llvm).not.toContain("@scr_resolve_adopt");
  expect(llvm).not.toContain("@scr_resolve_join");
});

test("a typed executor whose resolve is given a promise arm adopts it", async () => {
  const cases = [
    // The argument is a promise, or a union with a promise arm.
    "new Promise<number>((resolve) => { resolve(later()); })",
    "new Promise<number>((resolve) => { resolve(maybe(false)); })",
    "new Promise<number>((resolve, reject) => { if (made.length > 99) reject(new Error('x')); else resolve(later()); })",
    "new Promise<void>((resolve) => { resolve(later().then(() => {})); })",
    // From a closure the executor creates.
    "new Promise<number>((resolve) => { queueMicrotask(() => resolve(maybe(false))); })",
    // A scheduler passes the promise on.
    "new Promise<number>((resolve) => { setTimeout(resolve, 1, later()); })",
    "new Promise<number>((resolve) => { process.nextTick(resolve, maybe(false)); })",
    // The function is handed to a position whose callers may pass a promise.
    "new Promise<number>((resolve) => { stored = resolve; })",
    "new Promise<number>((resolve) => { exact = resolve; })",
    "new Promise<number>((resolve) => { settle(resolve); })",
  ];
  const llvm = await emit(`${typedPrelude}
const made: Promise<unknown>[] = [];
${cases.map((c) => `made.push(${c});`).join("\n")}
console.log(made.length, plain.length);
`);
  expect(adoptingExecutors(llvm)).toBe(cases.length);
  expect(resolvingCalls(llvm)).toBe(0);
  expect(llvm).toContain("call void @scr_resolve_adopt(");
  // One of the ten executors declares a reject function, which joins its
  // resolve function's target.
  expect(llvm.match(/call void @scr_resolve_join\(/g)?.length).toBe(1);
});

test("a typed executor with no value-or-promise union keeps its refusal", async () => {
  const outDir = await mkdtemp(join(tmpdir(), "scriptc-promise-resolution-"));
  directories.push(outDir);
  const entry = join(outDir, "main.ts");
  // A function-typed promise: a function beside a promise has no union.
  await writeFile(
    entry,
    `type Task = () => number;
function later(): Promise<Task> { return Promise.resolve(() => 1); }
new Promise<Task>((resolve) => { resolve(later()); }).then((task) => { console.log(task()); });
`,
  );
  const result = await compile(entry, {
    outDir,
    outPath: join(outDir, "program.ll"),
    outputKind: "llvm",
  });
  expect(result.ok).toBe(false);
  expect(JSON.stringify(result)).toMatch(/SC1090|SC2002|SC2003/);
});
