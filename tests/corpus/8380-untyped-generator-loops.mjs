// Untyped for-of and for await loops over generator objects: values,
// completion values, early exits, errors, other iterables through the same
// loop, and the microtask order of each step.
function* numbers(n) {
  for (let i = 0; i < n; i++) yield i;
  return "done";
}
function* mixed() {
  yield "a";
  yield { k: 1 };
  yield undefined;
  yield [1, 2];
  yield Promise.resolve(7);
  return 99;
}
async function* asyncNumbers(n) {
  for (let i = 0; i < n; i++) yield i * 10;
  return "async done";
}
async function* asyncMixed() {
  yield "x";
  yield Promise.resolve(8);
  yield null;
}

function collect(it) {
  const out = [];
  for (const x of it) out.push(x);
  return out;
}
async function collectAsync(it) {
  const out = [];
  for await (const x of it) out.push(x);
  return out;
}
const show = (v) => JSON.stringify(v, (k, x) => (x instanceof Promise ? "promise" : x === undefined ? "undef" : x));

async function main() {
  // The same loops over generators, arrays, Maps, strings and custom iterators.
  console.log("sync", show(collect(numbers(4))), show(collect(mixed())));
  console.log("sync other", show(collect([1, 2])), show(collect(new Map([[1, 2]]))), show(collect("hé")));
  const custom = {
    [Symbol.iterator]() {
      let i = 0;
      return { next: () => ({ value: i * i, done: i++ > 2 }) };
    },
  };
  console.log("sync custom", show(collect(custom)));
  console.log("async", show(await collectAsync(asyncNumbers(3))), show(await collectAsync(asyncMixed())));
  console.log("async over sync", show(await collectAsync(mixed())), show(await collectAsync(numbers(3))));
  console.log("async other", show(await collectAsync([Promise.resolve(1), 2])), show(await collectAsync(custom)));
  const asyncCustom = {
    [Symbol.asyncIterator]() {
      let i = 0;
      return { next: async () => ({ value: `c${i}`, done: i++ > 1 }) };
    },
  };
  console.log("async custom", show(await collectAsync(asyncCustom)));
  // Symbol.asyncIterator returning a sync generator: each result is awaited,
  // its value is not, so a yielded promise reaches the loop as a promise.
  const viaAsyncIterator = { [Symbol.asyncIterator]: () => mixed() };
  const seen = [];
  for await (const x of viaAsyncIterator) seen.push(x instanceof Promise ? `promise ${await x}` : x);
  console.log("async iterator sync", show(seen));

  // A generator that has started keeps its position; one that finished stays done.
  const started = numbers(5);
  started.next();
  console.log("started", show(collect(started)), show(started.next()));

  // Early exits close the generator: finally blocks run once.
  function* guarded(label) {
    try {
      yield 1;
      yield 2;
    } finally {
      console.log(label, "finally");
    }
  }
  const pick = (v) => v;
  for (const x of pick(guarded("break"))) {
    console.log("break at", x);
    break;
  }
  try {
    for (const x of pick(guarded("throw"))) throw new Error(`body ${x}`);
  } catch (e) {
    console.log("caught", e.message);
  }
  const g = pick(guarded("after"));
  for (const x of g) {
    if (x === 1) break;
  }
  console.log("after break", show(g.next()));
  async function* aguarded(label) {
    try {
      yield 1;
      yield 2;
    } finally {
      console.log(label, "finally");
    }
  }
  for await (const x of pick(aguarded("abreak"))) {
    console.log("abreak at", x);
    break;
  }
  for await (const x of pick(guarded("sync abreak"))) {
    console.log("sync abreak at", x);
    break;
  }

  // Errors from the generator body reach the loop.
  function* failing() {
    yield 1;
    throw new TypeError("generator failed");
  }
  async function* afailing() {
    yield 1;
    throw new RangeError("async generator failed");
  }
  try {
    for (const x of pick(failing())) console.log("failing got", x);
  } catch (e) {
    console.log("caught", e.name, e.message);
  }
  try {
    for await (const x of pick(afailing())) console.log("afailing got", x);
  } catch (e) {
    console.log("caught", e.name, e.message);
  }
  // Microtask order: each step against a promise chain ticking alongside.
  const ticker = (label, n) => {
    let p = Promise.resolve();
    for (let i = 0; i < n; i++) p = p.then(() => console.log(label, "tick", i));
    return p;
  };
  const consume = async (label, it) => {
    for await (const x of it) console.log(label, "value", x);
    console.log(label, "end");
  };
  await Promise.all([consume("sync", pick(numbers(3))), ticker("sync", 10)]);
  await Promise.all([consume("async", pick(asyncNumbers(3))), ticker("async", 10)]);
  await Promise.all([consume("promises", pick(mixed())), ticker("promises", 14)]);

  // Stages chained through untyped parameters.
  async function* double(src) {
    for await (const x of src) yield x * 2;
  }
  async function* keepOdd(src) {
    for await (const x of src) if (x % 4 !== 0) yield x;
  }
  let sum = 0;
  for await (const x of keepOdd(double(asyncNumbers(50)))) sum += x;
  console.log("stages", sum);
  let syncSum = 0;
  function* inc(src) {
    for (const x of src) yield x + 1;
  }
  for (const x of inc(inc(numbers(100)))) syncSum += x;
  console.log("sync stages", syncSum);
}
main();
