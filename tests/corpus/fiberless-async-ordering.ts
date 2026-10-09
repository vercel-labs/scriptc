// Await-free async functions complete before their call returns, so the
// compiler runs them without a fiber. Their promises must still behave
// exactly like any other settled promise: awaiting one takes the microtask
// hop, then/catch reactions interleave with queueMicrotask and nextTick in
// Node's order, rejections surface at the await or reach a catch handler,
// and a fiberless body may spawn a suspending async function whose
// continuation resumes later from the event loop.
import { AsyncLocalStorage } from "node:async_hooks";

const log: string[] = [];
async function syncValue(n: number): Promise<number> {
  log.push("syncValue " + n);
  return n * 2;
}
async function syncVoid(label: string): Promise<void> {
  console.log("syncVoid", label);
}
async function syncThrow(message: string): Promise<number> {
  console.log("syncThrow", message);
  throw new Error(message);
}
async function syncString(s: string): Promise<string> {
  return s + "!";
}
async function syncBool(n: number): Promise<boolean> {
  return n > 0;
}
interface Rec {
  id: number;
  tags: string[];
}
async function syncRecord(id: number): Promise<Rec> {
  return { id, tags: ["t" + id, "u" + id] };
}
async function syncError(): Promise<Error> {
  return new Error("made in an await-free body");
}
function helper(n: number): number {
  return n + 1;
}
async function viaHelper(n: number): Promise<number> {
  return helper(helper(n));
}
async function countdown(n: number): Promise<number> {
  if (n === 0) return 0;
  countdown(n - 1).then((v) => console.log("countdown settled", n - 1, v));
  return n;
}
async function suspends(label: string): Promise<number> {
  console.log("suspends start", label);
  await null;
  console.log("suspends resumed", label);
  return 7;
}
async function fiberlessCallsSuspending(): Promise<number> {
  const p = suspends("inner");
  console.log("fiberless after spawn");
  p.then((v) => console.log("inner settled", v));
  return 1;
}
async function chain(label: string, n: number): Promise<number> {
  let total = 0;
  for (let i = 0; i < n; i++) {
    const v = await syncValue(i);
    console.log("chain", label, i, v);
    total += v;
  }
  return total;
}
class Service {
  readonly base: number;
  constructor(base: number) {
    this.base = base;
  }
  async get(n: number): Promise<number> {
    return this.base + n;
  }
  async fail(): Promise<string> {
    throw new RangeError("service failure " + this.base);
  }
}

const store = new AsyncLocalStorage<string>();
async function readStore(): Promise<string> {
  return store.getStore() ?? "none";
}

async function main(): Promise<void> {
  const a = syncValue(1);
  console.log("after syncValue call:", log.join(","));
  queueMicrotask(() => console.log("microtask A"));
  a.then((v) => console.log("then a", v));
  Promise.resolve(5).then((v) => console.log("resolved then", v));
  process.nextTick(() => console.log("tick"));
  console.log("await a", await a);
  console.log("string", await syncString("x"), "bool", await syncBool(2), await syncBool(-1));
  const record = await syncRecord(3);
  console.log("record", record.id, record.tags.join("|"));
  await syncVoid("v");
  console.log("helper", await viaHelper(1));
  try {
    await syncThrow("bad");
  } catch (e) {
    console.log("caught", (e as Error).message);
  }
  const rejected = syncThrow("later");
  console.log("rejected created");
  rejected.catch((e: unknown) => console.log("catch handler", e instanceof Error ? e.message : e));
  try {
    await rejected;
  } catch (e) {
    console.log("caught again", (e as Error).message);
  }
  const fanout: Promise<number>[] = [syncValue(10), syncValue(11), suspends("all")];
  const all = await Promise.all(fanout);
  console.log("all", all.join(","));
  const mapped = await Promise.all([1, 2, 3].map(syncValue));
  console.log("mapped", mapped.join(","));
  const raced = await Promise.race([suspends("race"), syncValue(20)]);
  console.log("raced", raced);
  const chains: Promise<number>[] = [chain("A", 3), chain("B", 3)];
  const totals = await Promise.all(chains);
  console.log("totals", totals.join(","));
  try {
    try {
      throw new Error("outer");
    } finally {
      syncThrow("in finally").catch((e: unknown) =>
        console.log("finally rejection", e instanceof Error ? e.message : e),
      );
    }
  } catch (e) {
    console.log("outer survived", (e as Error).message);
  }
  console.log("fiberless->suspending", await fiberlessCallsSuspending());
  console.log("countdown", await countdown(3));
  let counter = 0;
  const bump = async (k: number): Promise<number> => {
    counter += k;
    return counter;
  };
  console.log("closure", await bump(2), await bump(3), counter);
  const service = new Service(100);
  console.log("method", await service.get(1));
  try {
    await service.fail();
  } catch (e) {
    console.log("method rejection", e instanceof RangeError, (e as Error).message);
  }
  const error = await syncError();
  console.log("stack", error.message, error.stack!.includes("at syncError"));
  console.log("store", await store.run("scoped", readStore), await readStore());
}

main().then(() => console.log("main done"));
console.log("sync end");
