// AsyncLocalStorage contexts of async generator steps. Each step starts in
// the context of the next(), return() or throw() call that resumes it,
// whatever context created the generator; a store the step enters before
// its first await is the caller's after the call, and after an await the
// step keeps its own copy. A request queued behind a running step starts
// in that step's context, and a return() at a yield unwinds in the
// return() call's context. Covers yield*, for await with break, and two
// generators resumed in turn.
import { AsyncLocalStorage } from "node:async_hooks";

const store = new AsyncLocalStorage<string>();
const lines: string[] = [];
const log = (what: string): void => {
  lines.push(`${what}: ${store.getStore() ?? "none"}`);
};

async function* steps(): AsyncGenerator<number, void, undefined> {
  log("body start");
  yield 1;
  log("after the first yield");
  await null;
  log("after an await");
  store.enterWith("inside");
  yield 2;
  log("after the second yield");
  yield 3;
  log("body end");
}
const it = store.run("create", () => steps());
await store.run("next-1", () => it.next());
log("caller after next-1");
await store.run("next-2", () => it.next());
log("caller after next-2");
await store.run("next-3", () => it.next());
await store.run("next-4", () => it.next());

async function* prefixes(): AsyncGenerator<number, void, undefined> {
  store.enterWith("prefix");
  yield 1;
  store.enterWith("step-2");
  await null;
  log("after an await in step 2");
  yield 2;
}
await store.run("outer", async () => {
  const gen = prefixes();
  const first = gen.next();
  log("synchronously after next");
  await first;
  log("after awaiting next");
  const second = gen.next();
  log("synchronously after the second next");
  await second;
  log("after awaiting the second next");
});

async function* queued(): AsyncGenerator<number, void, undefined> {
  log("queued start");
  yield 1;
  log("queued resumed");
  yield 2;
}
const q = queued();
await Promise.all([store.run("q-1", () => q.next()), store.run("q-2", () => q.next())]);

async function* inner(): AsyncGenerator<string, void, undefined> {
  log("inner start");
  yield "a";
  log("inner resumed");
  yield "b";
}
async function* outerGen(): AsyncGenerator<string, void, undefined> {
  log("outer start");
  yield* inner();
  log("outer after yield*");
}
const delegating = outerGen();
await store.run("o-1", () => delegating.next());
await store.run("o-2", () => delegating.next());
await store.run("o-3", () => delegating.next());

async function* catching(): AsyncGenerator<number, void, undefined> {
  try {
    yield 1;
  } catch (e) {
    log(`caught ${(e as Error).message}`);
    yield 2;
  }
}
const c = catching();
await store.run("t-1", () => c.next());
await store.run("t-2", () => c.throw(new Error("boom")));

async function* finallyGen(): AsyncGenerator<number, void, undefined> {
  try {
    yield 1;
  } finally {
    log("finally");
  }
}
const f = finallyGen();
await store.run("n", () => f.next());
await store.run("return-call", () => f.return());

async function* endless(): AsyncGenerator<number, void, undefined> {
  let i = 0;
  try {
    while (true) {
      log(`endless ${i}`);
      yield i++;
    }
  } finally {
    log("endless finally");
  }
}
await store.run("loop", async () => {
  for await (const v of endless()) {
    if (v === 1) break;
  }
});

async function* named(name: string): AsyncGenerator<number, void, undefined> {
  log(`${name} 1`);
  yield 1;
  log(`${name} 2`);
  yield 2;
}
const a = named("A");
const b = named("B");
await Promise.all([store.run("a-1", () => a.next()), store.run("b-1", () => b.next())]);
await Promise.all([store.run("b-2", () => b.next()), store.run("a-2", () => a.next())]);

for (const line of lines) console.log(line);
