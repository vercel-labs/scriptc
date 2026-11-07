// @requires-libnode
// An island object with a then method is a thenable to every promise
// resolution, as in Node: await, Promise.resolve, the entries of a
// combinator, the return value of an async function and an executor's
// resolve; with a then that resolves, rejects, throws or never settles.
import { requireModule } from "@scriptc/node";

const lib = requireModule("./lib.cjs");
const log = (...a) => console.log(...a);

const forms = {
  await: async (make) => await make(),
  resolve: (make) => Promise.resolve(make()),
  all: async (make) => (await Promise.all([make(), 1]))[0],
  allSettled: async (make) => {
    const [r] = await Promise.allSettled([make()]);
    if (r.status === "rejected") throw r.reason;
    return r.value;
  },
  any: (make) => Promise.any([make()]),
  asyncReturn: async (make) => make(),
  executor: (make) => new Promise((resolve) => resolve(make())),
  then: (make) => Promise.resolve(0).then(() => make()),
};

async function outcome(run, make) {
  const never = Symbol("never");
  try {
    const v = await new Promise((resolve, reject) => {
      Promise.resolve(run(make)).then(resolve, reject);
      setTimeout(() => resolve(never), 20);
    });
    if (v === never) return "pending";
    return `resolved ${typeof v === "object" && v !== null ? `object ${v.tag} ${typeof v.then}` : String(v)}`;
  } catch (e) {
    const reason = e instanceof AggregateError ? e.errors[0] : e;
    return `rejected ${reason.message}`;
  }
}

for (const [name, run] of Object.entries(forms)) {
  log(name, "resolves:", await outcome(run, () => lib.resolves(1)));
  log(name, "later:", await outcome(run, () => lib.later(2)));
  log(name, "query:", await outcome(run, () => lib.query(21)));
  log(name, "chained:", await outcome(run, () => lib.chained(3)));
  log(name, "promised:", await outcome(run, () => lib.promised(4)));
  log(name, "rejects:", await outcome(run, () => lib.rejects("thenable rejected")));
  log(name, "throws:", await outcome(run, () => lib.throws("then threw")));
  log(name, "resolves then throws:", await outcome(run, () => lib.resolvesThenThrows(5)));
  log(name, "getter throws:", await outcome(run, () => lib.getterThrows("getter threw")));
  log(name, "never:", await outcome(run, () => lib.never()));
  log(name, "not callable:", await outcome(run, () => lib.notCallable()));
}

// then is read once and called once, with the thenable as this and two functions.
for (const [name, run] of Object.entries(forms)) {
  const c = lib.counting();
  await run(() => c);
  log(name, "calls:", c.calls.join(" "));
}

// An executor that resolved its promise with a thenable has resolved it: a
// later resolve, reject or throw in the executor changes nothing.
const settled = (label, p) =>
  p.then(
    (v) => log(label, "fulfilled", v),
    (e) => log(label, "rejected", e.message),
  );
await settled("resolve then reject", new Promise((resolve, reject) => {
  resolve(lib.later(1));
  reject(new Error("late reject"));
}));
await settled("resolve then resolve", new Promise((resolve) => {
  resolve(lib.later(2));
  resolve(3);
}));
await settled("resolve then throw", new Promise((resolve) => {
  resolve(lib.later(4));
  throw new Error("thrown after");
}));
await settled("settled thenable then reject", new Promise((resolve, reject) => {
  resolve(lib.resolves(5));
  reject(new Error("late reject"));
}));
await settled("reject then resolve", new Promise((resolve, reject) => {
  reject(new Error("first"));
  resolve(lib.later(6));
}));
await settled("plain island object then reject", new Promise((resolve, reject) => {
  resolve(lib.notCallable().tag);
  reject(new Error("late reject"));
}));

// The turns a thenable takes.
const order = [];
let p = Promise.resolve();
for (let i = 1; i <= 5; i++) p = p.then(() => order.push(`turn ${i}`));
(async () => {
  await lib.resolves(0);
  order.push("awaited island thenable");
})();
(async () => {
  await Promise.resolve(0);
  order.push("awaited native promise");
})();
Promise.resolve(lib.resolves(0)).then(() => order.push("resolved island thenable"));
await p;
log(order.join(", "));
