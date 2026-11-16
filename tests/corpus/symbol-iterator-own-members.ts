// A class's own [Symbol.iterator] member answers before the runtime's generic
// iterable shortcut: a Map iterator is its own iterator, URLSearchParams
// answers its entries function, and a generator's iterator drains the same
// way. A native handle that models the member itself (node:sqlite's statement
// iterator) takes the same path.
const map = new Map<string, number>([
  ["a", 1],
  ["b", 2],
]);
const keys = map.keys();
console.log(keys[Symbol.iterator]() === keys);
console.log([...keys]);
const entries = map.entries();
console.log([...entries]);

const params = new URLSearchParams("a=1&b=2");
console.log([...params]);
console.log([...params[Symbol.iterator]()]);

function* numbers(): Generator<number> {
  yield 1;
  yield 2;
}
console.log([...numbers()]);
