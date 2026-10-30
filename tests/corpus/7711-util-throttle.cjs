// util.throttle: limits per interval, queueing, overflow 'drop', maxPending,
// concurrency, strict windows, cancel, options.signal, validation and the
// returned function's own members.
const util = require("node:util");

const settle = (label, p) => p.then((v) => console.log(label, "ok", v), (e) => console.log(label, "err", e.name, e.code, e.message));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  // Two calls per 60 ms; the rest queue in order.
  const seen = [];
  const t = util.throttle(function (x) { seen.push(x); return x * 2; }, 2, 60);
  const ps = [1, 2, 3, 4, 5].map((x) => t(x));
  console.log(seen, t.pendingCount, t.activeCount, t.pending === ps[4], t.hasImmediateCapacity());
  console.log(await Promise.all(ps), seen);

  // overflow 'drop' rejects with ERR_THROTTLED once the window is full.
  const d = util.throttle((x) => x, 1, 1000, { overflow: "drop" });
  await settle("drop-first", d(1));
  await settle("drop-second", d(2));
  d.cancel();
  await settle("after-cancel", d(3));

  // maxPending bounds the queue.
  const m = util.throttle((x) => x, 1, 30, { maxPending: 1 });
  const m1 = m(1), m2 = m(2), m3 = m(3);
  await settle("max1", m1);
  await settle("max3", m3);
  await settle("max2", m2);

  // concurrency counts unsettled async calls.
  const order = [];
  const c = util.throttle(async (x) => { order.push(`start ${x}`); await sleep(15); order.push(`end ${x}`); return x; }, 10, 1000, { concurrency: 1 });
  const ca = c("a"), cb = c("b");
  console.log(c.activeCount, c.pendingCount);
  console.log(await ca, await cb, order, c.activeCount);

  // A queue that never empties while calls are taken and others arrive.
  const q = util.throttle(async (x) => { await null; return x; }, 1000, 1000, { concurrency: 1 });
  const queued = [];
  for (let i = 0; i < 5; i++) queued.push(q(i));
  const results = [];
  for (let i = 5; i < 25; i++) {
    results.push(await queued[i - 5]);
    queued.push(q(i));
  }
  for (let i = 20; i < 25; i++) results.push(await queued[i]);
  console.log(results.join(","), q.pendingCount, q.activeCount);

  // A throwing fn rejects that call only.
  const e = util.throttle((x) => { if (x === 2) throw new RangeError("two"); return x; }, 5, 10);
  await settle("e1", e(1));
  await settle("e2", e(2));
  await settle("e3", e(3));

  // strict keeps a rolling window.
  const s = util.throttle((x) => x, 1, 25, { strict: true });
  const s1 = s(1), s2 = s(2);
  console.log(s.hasImmediateCapacity(), await s1, await s2);

  // cancel rejects the queue and resets the limiter.
  const k = util.throttle((x) => x, 1, 1000);
  const k1 = k(1), k2 = k(2);
  k.cancel("why");
  await settle("k1", k1);
  await settle("k2", k2);
  console.log(k.hasImmediateCapacity(), k.ref() === k, k.unref() === k);
  await settle("k3", k(3));

  // options.signal
  const ac = new AbortController();
  const a = util.throttle((x) => x, 1, 1000, { signal: ac.signal });
  await settle("a1", a(1));
  const a2 = a(2);
  ac.abort();
  await settle("a2", a2);
  await settle("a3", a(3));
  console.log(a.hasImmediateCapacity(), a.pendingCount);
}
main().then(tail);

function tail() {
  const tryIt = (run) => { try { run(); } catch (e) { console.log(e.name, e.code, e.message); } };
  tryIt(() => util.throttle(null, 1, 5));
  tryIt(() => util.throttle(() => 1, 0, 5));
  tryIt(() => util.throttle(() => 1, 1.5, 5));
  tryIt(() => util.throttle(() => 1, 1, 2 ** 31));
  tryIt(() => util.throttle(() => 1, 1, 5, "options"));
  tryIt(() => util.throttle(() => 1, 1, 5, { concurrency: 0 }));
  tryIt(() => util.throttle(() => 1, 1, 5, { concurrency: "2" }));
  tryIt(() => util.throttle(() => 1, 1, 5, { overflow: "x" }));
  tryIt(() => util.throttle(() => 1, 1, 5, { maxPending: -1 }));
  tryIt(() => util.throttle(() => 1, 1, 5, { strict: "y" }));
  tryIt(() => util.throttle(() => 1, 1, 5, { signal: AbortSignal.abort("pre") }));

  const t = util.throttle(() => 1, 1, 50, { overflow: "drop" });
  console.log(Object.keys(t), Object.getOwnPropertyNames(t), t.name, t.length);
  console.log(t);
  t();
  t().catch((e) => console.log(e.name, e.code, e.message, Object.keys(e)));
}
