// for-of and spread in JavaScript over classes whose [Symbol.iterator]() returns an
// iterator object, with return() called on early exits as Node's IteratorClose does.
class Bag {
  
  constructor(items) { this.items = items; }
  [Symbol.iterator]() {
    let i = 0;
    const items = this.items;
    return {
      next() {
        return i < items.length ? { value: items[i++], done: false } : { value: undefined, done: true };
      },
      return() {
        console.log("return at", i);
        return { value: undefined, done: true };
      },
    };
  }
}
const bag = new Bag(["a", "b", "c", "d"]);
function firstLong() {
  for (const s of bag) if (s >= "b") return s;
  return undefined;
}
console.log(firstLong());
try {
  for (const s of bag) if (s === "c") throw new Error("stop at " + s);
} catch (e) {
  console.log(e.message);
}
outer: for (const n of [1, 2]) {
  for (const s of bag) {
    if (s === "b") continue outer;
    console.log(n, s);
  }
}
let all = "";
for (const s of bag) all += s;
console.log(all);

class Counter {
  n = 0;
  [Symbol.iterator]() { return new CounterIterator(3); }
}
class CounterIterator {
  i = 0;
  
  constructor(limit) { this.limit = limit; }
  next() {
    return this.i < this.limit ? { value: this.i++, done: false } : { value: -1, done: true };
  }
  return() {
    console.log("class return", this.i);
    return { value: -1, done: true };
  }
}
for (const v of new Counter()) { if (v === 1) break; console.log("v", v); }
console.log([...new Counter()].join());

class Fussy {
  [Symbol.iterator]() {
    let i = 0;
    return {
      next() { return { value: i++, done: i > 5 }; },
      return() { if (i >= 0) throw new Error("return failed"); return { value: undefined, done: true }; },
    };
  }
}
try {
  for (const v of new Fussy()) if (v === 1) break;
} catch (e) {
  console.log("break:", e.message);
}
try {
  for (const v of new Fussy()) if (v === 1) throw new Error("body failed");
} catch (e) {
  console.log("throw:", e.message);
}
