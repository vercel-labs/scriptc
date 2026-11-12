// JSDoc type references that leave out a generic's type arguments: tsc reads
// `{Array}` as `Array<any>`, `{Map}` as `Map<any, any>`, and so on. Node never
// reads the comment, so the annotation documents the usual value without
// failing the build, and each function behaves as its body says.
/** @param {Array} list */
function count(list) {
  return list.length;
}

/** @param {Map} entries @param {Set} seen */
function collect(entries, seen) {
  for (const [key, value] of entries) seen.add(`${key}=${value}`);
  return seen.size;
}

/** @param {WeakMap} cache @param {WeakSet} ready */
function remember(cache, ready, key, value) {
  cache.set(key, value);
  ready.add(key);
  return `${cache.get(key)}:${ready.has(key)}`;
}

const seen = new Set();
const cache = new WeakMap();
const ready = new WeakSet();
const key = {};
console.log(count([1, 2, 3]));
console.log(collect(new Map([["a", 1], ["b", 2]]), seen));
console.log(remember(cache, ready, key, "kept"));
console.log(remember(cache, ready, { other: true }, "second"), ready.has(key));
