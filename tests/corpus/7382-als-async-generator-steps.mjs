// AsyncLocalStorage contexts of async generator steps from JavaScript:
// steps start in the context of the call that resumes them, a store a step
// enters before its first await is the caller's, queued requests start in
// the running step's context, and return() at a yield unwinds in the
// return() call's context.
import { AsyncLocalStorage } from "node:async_hooks";
const s = new AsyncLocalStorage();
const lines = [];
const g = (t) => lines.push(`${t}: ${s.getStore() ?? "none"}`);
async function* gen() {
  g("body start");
  yield 1;
  g("after first yield");
  await null;
  g("after await");
  s.enterWith("inside");
  yield 2;
  g("after second yield");
  yield 3;
  g("body end");
}
const it = s.run("create", () => gen());
await s.run("next1", () => it.next());
g("caller after next1");
await s.run("next2", () => it.next());
g("caller after next2");
await s.run("next3", () => it.next());
await s.run("next4", () => it.next());
// concurrent next calls queued
async function* gen2() { g("g2 start"); yield 1; g("g2 resumed"); yield 2; }
const it2 = gen2();
const p1 = s.run("q1", () => it2.next());
const p2 = s.run("q2", () => it2.next());
await Promise.all([p1, p2]);
// for await
async function* gen3() { for (let i = 0; i < 2; i++) { g("g3 step " + i); yield i; } }
await s.run("for-await", async () => { for await (const v of gen3()) g("loop body " + v); });
// return/throw
async function* gen4() { try { yield 1; } finally { g("g4 finally"); } }
const it4 = gen4();
await s.run("n", () => it4.next());
await s.run("ret", () => it4.return());
for (const line of lines) console.log(line);
