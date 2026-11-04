// The interned Proxy constructor value answers own-key queries as Node's
// Proxy does: it has no `prototype` own property, and hasOwnProperty sees
// exactly its own keys (length, name, revocable). A query the interned value
// answers faithfully must not be the SC2020 reflection fence. Object
// .getOwnPropertyNames is a reflection the interned value keeps fenced, so
// this program asks only the own-key query Web IDL and Test262 use.
for (const key of ["prototype", "name", "length", "revocable", "call", "toString", "get"]) {
  console.log(key, Object.prototype.hasOwnProperty.call(Proxy, key));
}
console.log(Proxy === globalThis.Proxy, typeof Proxy, Proxy.name, Proxy.length);
console.log(Object.prototype.hasOwnProperty.call(Proxy, Symbol.hasInstance));
