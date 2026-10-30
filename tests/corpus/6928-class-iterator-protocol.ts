// for-of and spread over classes whose [Symbol.iterator]() returns an iterator object,
// with return() called on early exits as Node's IteratorClose does.
class Bag {
  readonly items: string[];
  constructor(items: string[]) { this.items = items; }
  [Symbol.iterator]() {
    let i = 0;
    const items = this.items;
    return {
      next(): IteratorResult<string> {
        return i < items.length ? { value: items[i++]!, done: false } : { value: undefined, done: true };
      },
      return(): IteratorResult<string> {
        console.log("return at", i);
        return { value: undefined, done: true };
      },
    };
  }
}
const bag = new Bag(["a", "b", "c", "d"]);
function firstLong(): string | undefined {
  for (const s of bag) if (s >= "b") return s;
  return undefined;
}
console.log(firstLong());
try {
  for (const s of bag) if (s === "c") throw new Error("stop at " + s);
} catch (e) {
  console.log((e as Error).message);
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
  [Symbol.iterator](): CounterIterator { return new CounterIterator(3); }
}
class CounterIterator {
  i = 0;
  readonly limit: number;
  constructor(limit: number) { this.limit = limit; }
  next(): { value: number; done: boolean } {
    return this.i < this.limit ? { value: this.i++, done: false } : { value: -1, done: true };
  }
  return(): { value: number; done: boolean } {
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
      next(): IteratorResult<number> { return { value: i++, done: i > 5 }; },
      return(): IteratorResult<number> { throw new Error("return failed"); },
    };
  }
}
try {
  for (const v of new Fussy()) if (v === 1) break;
} catch (e) {
  console.log("break:", (e as Error).message);
}
try {
  for (const v of new Fussy()) if (v === 1) throw new Error("body failed");
} catch (e) {
  console.log("throw:", (e as Error).message);
}

class Range {
  readonly n: number;
  constructor(n: number) { this.n = n; }
  [Symbol.iterator]() {
    let i = 0;
    const n = this.n;
    return {
      next(): IteratorResult<number> { return i < n ? { value: i++, done: false } : { value: undefined, done: true }; },
    };
  }
}
let total = 0;
for (const v of new Range(4)) total += v;
console.log(total, [...new Range(3)].join());

// An object-literal iterator that replaces its next() while it runs: the
// loop and the spread keep calling the next() they read when it opened.
class Swapping {
  [Symbol.iterator]() {
    let i = 0;
    const it = {
      next(): { value: number; done: boolean } {
        i++;
        if (i === 2) it.next = () => ({ value: -1, done: true });
        return { value: i, done: i > 4 };
      },
    };
    return it;
  }
}
const swapped: number[] = [];
for (const v of new Swapping()) swapped.push(v);
console.log(swapped.join(), [...new Swapping()].join());
