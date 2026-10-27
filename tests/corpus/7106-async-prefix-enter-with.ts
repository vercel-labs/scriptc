// AsyncLocalStorage.enterWith in an async callee: before the callee's first
// await it runs in the caller's execution, so the caller sees the store
// after the call (Node's semantics), and the callee keeps it after its own
// await; after the first await it stays inside the callee. Covers callees
// that never suspend, stackless and fiber-backed callees, nested callees,
// run() scopes inside the prefix, and calls without an await. A store that
// an event-loop callback enters this way, or through a generator step, ends
// with that callback and does not reach the next one.
import { AsyncLocalStorage } from "node:async_hooks";

const store = new AsyncLocalStorage<string>();
const log: string[] = [];
const current = (): string => store.getStore() ?? "none";

async function neverSuspends(tag: string): Promise<number> {
  store.enterWith(`never-${tag}`);
  return 1;
}
async function prefixThenAwait(tag: string): Promise<number> {
  store.enterWith(`prefix-${tag}`);
  await null;
  log.push(`callee ${tag} after its await: ${current()}`);
  return 2;
}
async function afterAwait(tag: string): Promise<number> {
  await null;
  store.enterWith(`after-${tag}`);
  return 3;
}
async function nested(tag: string): Promise<number> {
  await neverSuspends(`inner-${tag}`);
  log.push(`nested ${tag} after its callee: ${current()}`);
  return 4;
}
async function runInPrefix(tag: string): Promise<number> {
  store.run(`run-${tag}`, () => store.enterWith("inside-run"));
  return 5;
}
async function* ticks(): AsyncGenerator<number, void, undefined> {
  yield 1;
}
async function fibered(tag: string): Promise<number> {
  store.enterWith(`fibered-${tag}`);
  let n = 0;
  for await (const t of ticks()) n += t;
  log.push(`fibered ${tag} after its loop: ${current()}`);
  return n;
}

function* steps(): Generator<number, void, undefined> {
  store.enterWith("generator-step");
  yield 1;
}
function callbacks(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(() => {
      void prefixThenAwait("9");
      log.push(`timer after the call: ${current()}`);
    }, 0);
    setTimeout(() => {
      log.push(`second timer: ${current()}`);
      steps().next();
      log.push(`second timer after a generator step: ${current()}`);
    }, 0);
    setTimeout(() => {
      log.push(`third timer: ${current()}`);
      void neverSuspends("10");
      log.push(`third timer after the call: ${current()}`);
    }, 0);
    setTimeout(() => {
      log.push(`last timer: ${current()}`);
      resolve();
    }, 0);
  });
}

async function main(): Promise<void> {
  await store.run("A", async () => {
    await neverSuspends("1");
    log.push(`A after neverSuspends: ${current()}`);
  });
  await store.run("B", async () => {
    const pending = prefixThenAwait("2");
    log.push(`B after the call: ${current()}`);
    store.enterWith("B-later");
    await pending;
    log.push(`B after its await: ${current()}`);
  });
  await store.run("C", async () => {
    await afterAwait("3");
    log.push(`C after afterAwait: ${current()}`);
  });
  await store.run("D", async () => {
    await nested("4");
    log.push(`D after nested: ${current()}`);
  });
  await store.run("E", async () => {
    await runInPrefix("5");
    log.push(`E after runInPrefix: ${current()}`);
  });
  await store.run("F", async () => {
    void neverSuspends("6");
    log.push(`F after an unawaited call: ${current()}`);
    await null;
    log.push(`F later: ${current()}`);
  });
  store.run("G", () => {
    void neverSuspends("7");
    log.push(`G synchronous caller: ${current()}`);
  });
  await store.run("H", async () => {
    await fibered("8");
    log.push(`H after fibered: ${current()}`);
  });
  await callbacks();
  log.push(`main after the callbacks: ${current()}`);
  for (const line of log) console.log(line);
}
void main();
