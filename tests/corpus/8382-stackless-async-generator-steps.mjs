// Async generators whose bodies suspend only at their own awaits and yields:
// requests queued while the body awaits, return() and throw() at a yield and
// during an await, finally blocks that await, yield* into another async
// generator, awaits of plain values and of settled and pending promises, a
// deep chain of stages, and the microtask order around them.
const log = [];
const tick = (label) => Promise.resolve().then(() => log.push(label));
const later = (value) => new Promise((resolve) => setTimeout(() => resolve(value), 1));

async function* counter(n) {
  try {
    for (let i = 0; i < n; i++) {
      const v = await (i % 2 === 0 ? i : Promise.resolve(i));
      log.push(`yield ${v}`);
      yield v;
    }
    return "done";
  } finally {
    log.push("counter finally");
    await later(0);
    log.push("counter finally after await");
  }
}

// Requests queued before the body settles the first one.
{
  const it = counter(3);
  const requests = [];
  for (let i = 0; i < 5; i++) requests.push(it.next());
  const results = [];
  for (const request of requests) results.push(await request);
  console.log(JSON.stringify(results));
  console.log(log.splice(0).join(" | "));
}

// return() at a yield runs the finally block, which awaits.
{
  const it = counter(5);
  console.log(JSON.stringify(await it.next()));
  const ret = it.return("early");
  tick("tick after return()");
  console.log(JSON.stringify(await ret));
  console.log(JSON.stringify(await it.next()));
  console.log(log.splice(0).join(" | "));
}

// return() queued while the body awaits a pending promise.
async function* slow() {
  try {
    const v = await later(7);
    yield v;
    yield v + 1;
    return "slow done";
  } finally {
    log.push("slow finally");
  }
}
{
  const it = slow();
  const first = it.next();
  const ret = it.return("stopped");
  console.log(JSON.stringify(await first), JSON.stringify(await ret));
  console.log(log.splice(0).join(" | "));
}

// throw() at a yield, caught by the body, which keeps yielding.
async function* catcher() {
  for (let i = 0; ; i++) {
    try {
      yield i;
    } catch (e) {
      log.push(`caught ${e}`);
      await null;
      yield `recovered ${i}`;
      return;
    }
  }
}
{
  const it = catcher();
  console.log(JSON.stringify(await it.next()));
  console.log(JSON.stringify(await it.throw("boom")));
  console.log(JSON.stringify(await it.next()));
  console.log(log.splice(0).join(" | "));
}

// A body that throws after an await rejects its request and completes.
async function* failing() {
  yield 1;
  await later(0);
  throw new Error("failed after await");
}
{
  const it = failing();
  console.log(JSON.stringify(await it.next()));
  try {
    await it.next();
  } catch (e) {
    console.log("rejected:", e.message);
  }
  console.log(JSON.stringify(await it.next()));
}

// yield* into another async generator, and break out of for await.
async function* inner() {
  try {
    yield "a";
    yield await later("b");
    yield "c";
  } finally {
    log.push("inner finally");
  }
}
async function* outer() {
  yield "start";
  const r = yield* inner();
  log.push(`inner returned ${r}`);
  yield "end";
}
{
  const seen = [];
  for await (const x of outer()) {
    seen.push(x);
    if (x === "b") break;
  }
  console.log(seen.join(","));
  console.log(log.splice(0).join(" | "));
}

// Stages chained through untyped values, interleaved with a promise chain.
async function* source(n) {
  for (let i = 0; i < n; i++) yield i;
}
async function* map(it, f) {
  for await (const x of it) yield await f(x);
}
async function* filter(it, p) {
  for await (const x of it) if (p(x)) yield x;
}
{
  const order = [];
  const chain = (async () => {
    for await (const x of filter(map(source(6), async (x) => x * 3), (v) => v % 2 === 0)) order.push(`item ${x}`);
  })();
  Promise.resolve()
    .then(() => order.push("p1"))
    .then(() => order.push("p2"))
    .then(() => order.push("p3"));
  await chain;
  console.log(order.join(" "));
}

// A deep chain of pass-through stages.
async function* pass(it) {
  for await (const x of it) yield x;
}
function stack(depth) {
  return depth === 0 ? source(4) : pass(stack(depth - 1));
}
{
  let sum = 0;
  for await (const x of stack(500)) sum += x;
  console.log("deep sum", sum);
}

// Generator objects keep their tag and protocol.
{
  const g = counter(1);
  console.log(Object.prototype.toString.call(g));
  console.log(JSON.stringify(await g.next()), JSON.stringify(await g.next()));
  log.splice(0);
}
