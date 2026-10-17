// Async functions that suspend only at their own awaits compile to
// stackless coroutines on native targets. Their turns must interleave with
// every other kind of job exactly as Node's: the eager prefix runs inside
// the call, an await of a settled promise or a plain value takes one
// microtask turn, a pending promise resumes its awaiters in subscription
// order, a returned promise is adopted with its extra turns, and
// then-reactions, queueMicrotask, nextTick, timers and immediates keep
// their places around the continuations. Stackless bodies also await and
// are awaited by bodies that keep a fiber (an async generator consumer).
const log: string[] = [];
const say = (s: string): void => {
  log.push(s);
};

async function plain(label: string): Promise<number> {
  say(label + " prefix");
  await null;
  say(label + " after null");
  const v = await Promise.resolve(label.length);
  say(label + " after settled " + v);
  return v * 10;
}

let open: (v: string) => void = () => {};
const gate = new Promise<string>((resolve) => {
  open = resolve;
});

async function waiter(id: number): Promise<string> {
  say("waiter " + id + " waits");
  const v = await gate;
  say("waiter " + id + " woke " + v);
  await undefined;
  say("waiter " + id + " hop");
  return v + id;
}

async function returnsPromise(n: number): Promise<number> {
  say("returnsPromise " + n);
  return plain("rp" + n);
}

async function returnAwait(n: number): Promise<number> {
  say("returnAwait " + n);
  return await plain("ra" + n);
}

async function flags(n: number): Promise<boolean> {
  await null;
  return n % 2 === 0;
}

async function text(n: number): Promise<string> {
  const parts: string[] = [];
  for (let i = 0; i < n; i++) {
    parts.push(String(await Promise.resolve(i)));
  }
  return parts.join(",");
}

interface Pair {
  left: number;
  right: string;
}

async function record(n: number): Promise<Pair> {
  const left = await Promise.resolve(n);
  const right = await text(n);
  return { left, right };
}

async function maybe(p: Promise<number> | undefined): Promise<number | undefined> {
  const v = await p;
  say("maybe " + String(v));
  return v;
}

class Counter {
  total = 0;
  async add(n: number): Promise<number> {
    await null;
    this.total += n;
    await Promise.resolve();
    return this.total;
  }
}

async function* numbers(limit: number): AsyncGenerator<number> {
  for (let i = 0; i < limit; i++) {
    await null;
    yield i;
  }
}

async function consume(limit: number): Promise<number> {
  let sum = 0;
  for await (const n of numbers(limit)) {
    sum += await flags(n) ? n : 0;
  }
  say("consume " + sum);
  return sum;
}

async function syncLeaf(n: number): Promise<number> {
  say("leaf " + n);
  return n + 1;
}

async function syncThrow(n: number): Promise<number> {
  say("sync throw " + n);
  throw new Error("sync " + n);
}

async function relayLeaf(n: number): Promise<number> {
  return syncLeaf(n);
}

async function interleave(label: string): Promise<void> {
  say(label + " a " + (await syncLeaf(1)));
  try {
    await syncThrow(2);
  } catch (e) {
    say(label + " caught " + (e as Error).message);
  }
  say(label + " relay " + (await relayLeaf(3)));
}

async function main(): Promise<void> {
  say("main start");
  const a = plain("a");
  const b = plain("bb");
  say("main spawned");
  Promise.resolve().then(() => say("then 1"));
  queueMicrotask(() => say("microtask 1"));
  process.nextTick(() => say("tick 1"));
  const w1 = waiter(1);
  const w2 = waiter(2);
  const r1 = returnsPromise(1);
  const r2 = returnAwait(2);
  say("awaiting a " + (await a));
  say("awaiting b " + (await b));
  open("open");
  const w3 = waiter(3);
  say("w1 " + (await w1) + " w2 " + (await w2) + " w3 " + (await w3));
  say("r1 " + (await r1) + " r2 " + (await r2));
  say("flags " + (await flags(2)) + " " + (await flags(3)));
  say("text " + (await text(4)));
  const rec = await record(3);
  say("record " + rec.left + " " + rec.right);
  say("maybe " + String(await maybe(undefined)) + " " + String(await maybe(Promise.resolve(7))));
  const counter = new Counter();
  const adds: Promise<number>[] = [counter.add(1), counter.add(2), counter.add(3)];
  const sums = await Promise.all(adds);
  say("counter " + sums.join(" ") + " total " + counter.total);
  say("consumed " + (await consume(5)));
  const captured: number[] = [];
  let shared = 0;
  const bump = async (k: number): Promise<void> => {
    shared += k;
    await null;
    captured.push(shared);
    shared += k;
  };
  const bumps: Promise<void>[] = [bump(1), bump(10), bump(100)];
  await Promise.all(bumps);
  say("closures " + captured.join(" ") + " shared " + shared);
  const inline: Promise<void>[] = [interleave("x"), interleave("y")];
  queueMicrotask(() => say("inline microtask"));
  Promise.resolve().then(() => say("inline then"));
  await Promise.all(inline);
  say("inline done");
  // Macrotasks, each scheduled from the one before so their order is fixed:
  // the timer's microtask runs before the immediate it schedules.
  await new Promise<void>((resolve) => {
    setTimeout(() => {
      say("timeout");
      setImmediate(() => {
        say("immediate");
        resolve();
      });
      Promise.resolve().then(() => say("timeout microtask"));
      process.nextTick(() => say("timeout tick"));
    }, 0);
  });
  say("after macrotasks " + (await plain("m")));
}

main().then(() => {
  for (const line of log) console.log(line);
});
