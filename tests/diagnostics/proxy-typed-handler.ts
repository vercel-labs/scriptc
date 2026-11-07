// A handler whose traps take their types from ProxyHandler<T> compiles to a
// typed record, and the native Proxy dispatches traps through an untyped
// object: the construction would refuse every time it ran.
const counts = { hits: 1 };
const doubled = new Proxy(counts, {
  get(target, key) {
    return key === "hits" ? target.hits * 2 : 0;
  },
});
console.log(doubled.hits);
