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
