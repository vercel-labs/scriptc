// A read-only alias of a class's prototype view is the prototype object, as
// in Node: reflection through the alias sees the same members.
class Counter {
  value = 1;
  increment(): number {
    return ++this.value;
  }
  get doubled(): number {
    return this.value * 2;
  }
}
const prototype = Counter.prototype;
const alias = prototype;
console.log(Object.getOwnPropertyNames(alias).sort().join(","));
console.log(typeof alias, alias === prototype);
const increment = Object.getOwnPropertyDescriptor(alias, "increment");
console.log(typeof increment?.value, increment?.writable, increment?.enumerable);
console.log(Object.keys(alias).length, Object.getOwnPropertySymbols(alias).length);
console.log(Object.getPrototypeOf(alias) === Object.prototype);
