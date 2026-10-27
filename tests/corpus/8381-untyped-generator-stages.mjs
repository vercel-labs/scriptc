// Untyped stages chained through generator objects: a sync generator source
// consumed with for await, async generator transforms, an async function
// consumer, and the same stages over arrays and custom iterables.
function run(source, transform, destination) {
  return destination(transform(source()));
}
const N = 2000;
const total = await run(
  function* () {
    for (let i = 0; i < N; i++) yield i;
  },
  async function* (src) {
    for await (const n of src) yield n * 2;
  },
  async function (src) {
    let sum = 0;
    for await (const n of src) sum += n;
    return sum;
  },
);
console.log("total", total);

async function* map(it, f) {
  for await (const x of it) yield await f(x);
}
async function* take(it, n) {
  if (n <= 0) return;
  for await (const x of it) {
    yield x;
    if (--n === 0) return;
  }
}
async function* source(n) {
  try {
    for (let i = 0; i < n; i++) yield i;
  } finally {
    console.log("source closed");
  }
}
async function toArray(it) {
  const out = [];
  for await (const x of it) out.push(x);
  return out;
}
const half = async (x) => x / 2;
console.log(await toArray(take(map(source(10), half), 3)));
console.log(await toArray(map([1, 2, 3], half)));
console.log(await toArray(map(new Set(["a", "b"]), async (s) => s.toUpperCase())));
const words = {
  *[Symbol.iterator]() {
    yield "x";
    yield "y";
  },
};
console.log(await toArray(map(words, async (s) => s + s)));

// A stage that switches iterables between calls of the same loop.
function* letters() {
  yield "p";
  yield "q";
}
async function* numbersAsync() {
  yield 1;
  yield 2;
}
const sources = [letters(), numbersAsync(), ["z"], letters()];
for (const s of sources) console.log(await toArray(s));

// Sync stages: generator to generator through untyped parameters.
function* inc(src) {
  for (const x of src) yield x + 1;
}
function* evens(src) {
  for (const x of src) if (x % 2 === 0) yield x;
}
function* range(n) {
  for (let i = 0; i < n; i++) yield i;
  return "range done";
}
let s = 0;
for (const x of evens(inc(range(1000)))) s += x;
console.log("sync", s, [...inc([10, 20])], Array.from(evens(range(7))));
