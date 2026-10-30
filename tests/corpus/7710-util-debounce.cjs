// util.debounce: trailing and leading calls, flush, cancel, rejectOnCancel,
// receivers, re-entry, options.signal, validation, the returned
// function's own members, and unref'd timers at exit.
const util = require("node:util");

const settle = (label, p) => p.then((v) => console.log(label, "ok", v), (e) => console.log(label, "err", e.name, e.message, e.cause instanceof Error ? e.cause.message : e.cause));

async function main() {
  // Trailing calls collapse onto the last arguments.
  let calls = 0;
  const add = util.debounce(function (a, b) { calls++; return [this === add, a + b]; }, 20);
  const p1 = add(1, 2), p2 = add(3, 4), p3 = add(5, 6);
  console.log(add.pendingCount, add.pending === p3, p1 === p2);
  console.log(await p1, await p2, await p3, calls, add.pendingCount, add.pending);

  // leading: the first call runs at once, later ones trail.
  const lead = util.debounce((x) => x * 10, 15, { leading: true });
  const l1 = lead(1), l2 = lead(2);
  console.log(lead.pendingCount);
  console.log(await l1, await l2);

  // flush runs the pending call now; cancel rejects it.
  const f = util.debounce((x) => `ran ${x}`, 1000);
  const f1 = f("a");
  f.flush();
  console.log(await f1, f.pendingCount);
  f.flush();
  const c1 = f("b");
  f.cancel();
  await settle("cancel", c1);
  const c2 = f("c");
  f.cancel(new Error("stop"));
  await settle("cancel-reason", c2);
  f.cancel();

  // rejectOnCancel rejects superseded calls.
  const r = util.debounce((x) => x, 10, { rejectOnCancel: true });
  const r1 = r(1), r2 = r(2);
  await settle("superseded", r1);
  await settle("latest", r2);

  // A throwing fn rejects every waiting call.
  const t = util.debounce(() => { throw new TypeError("bad"); }, 5);
  const t1 = t(), t2 = t();
  await settle("throw1", t1);
  await settle("throw2", t2);

  // ref and unref answer the function.
  console.log(f.ref() === f, f.unref() === f, f.ref() === f);

  // options.signal: aborting rejects pending calls and every later call.
  const ac = new AbortController();
  const s = util.debounce((x) => x, 1000, { signal: ac.signal });
  const s1 = s(1);
  ac.abort("reason!");
  await settle("abort-pending", s1);
  await settle("abort-later", s(2));
  try {
    util.debounce(() => 1, 5, { signal: AbortSignal.abort("pre") });
  } catch (e) {
    console.log("pre-aborted", e.name, e.code, e.message, e.cause);
  }

  // Ordering against microtasks and a timer of the same delay.
  const order = [];
  const o = util.debounce(() => order.push("debounced"), 10);
  o().then(() => order.push("then"));
  setTimeout(() => order.push("timer"), 10);
  Promise.resolve().then(() => order.push("micro"));
  await new Promise((resolve) => setTimeout(resolve, 40));
  console.log(order);
}
main().then(tail);

function tail() {
  const tryIt = (run) => { try { run(); } catch (e) { console.log(e.name, e.code, e.message); } };
  tryIt(() => util.debounce(1, 5));
  tryIt(() => util.debounce(() => 1, -1));
  tryIt(() => util.debounce(() => 1, 1.5));
  tryIt(() => util.debounce(() => 1, "5"));
  tryIt(() => util.debounce(() => 1, 5, null));
  tryIt(() => util.debounce(() => 1, 5, [1]));
  tryIt(() => util.debounce(() => 1, 5, { leading: 1 }));
  tryIt(() => util.debounce(() => 1, 5, { rejectOnCancel: "yes" }));
  tryIt(() => util.debounce(() => 1, 5, { signal: {} }));

  const d = util.debounce(function named(a, b) { return a + b; }, 5);
  console.log(typeof d, d.name, d.length, Object.keys(d), Object.getOwnPropertyNames(d));
  console.log(d);
  const p = d(1, 2);
  console.log(d.pending === p, d.pendingCount);
  d.flush();

  const holder = {};
  holder.run = util.debounce(function () { return this === holder.run; }, 5);
  holder.run().then((same) => console.log("receiver is the function", same));
  let depth = 0;
  const again = util.debounce(function (n) {
    depth++;
    if (n > 0) again(n - 1).then((v) => console.log("inner", v));
    return n;
  }, 5);
  again(2).then((v) => console.log("outer", v, depth));

  const unrefd = util.debounce(() => console.log("never"), 500);
  unrefd();
  unrefd.unref();
  process.on("exit", () => console.log("exit", unrefd.pendingCount));
}
