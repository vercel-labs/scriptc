// Classes whose [Symbol.iterator] is a generator method iterate the
// generator it returns, called once: in for-of (an early exit closes it),
// array and Math.max spreads, Array.from, new Set, new Map,
// Object.fromEntries and yield*.
class Counter implements Iterable<number> {
  n: number;
  constructor(n: number) {
    this.n = n;
  }
  *[Symbol.iterator](): Generator<number> {
    for (let i = 0; i < this.n; i++) yield i;
  }
}
const c = new Counter(3);
for (const v of c) console.log("of", v);
console.log([...c], Array.from(c), Math.max(...c));
for (const v of c) {
  if (v === 1) break;
  console.log("early", v);
}

class Pairs implements Iterable<[string, number]> {
  *[Symbol.iterator](): Generator<[string, number]> {
    yield ["a", 1];
    yield ["b", 2];
  }
}
class Nums implements Iterable<number> {
  *[Symbol.iterator](): Generator<number> {
    yield 1;
    yield 2;
    yield 2;
  }
}
const p = new Pairs();
const n = new Nums();
console.log(new Set(n).size);
console.log(new Map(p).get("b"));

console.log(Object.fromEntries(p));
function* outer(): Generator<number> {
  yield 0;
  yield* n;
}
console.log([...outer()]);
function* plain(): Generator<number> {
  yield 3;
  yield 3;
  yield 4;
}
console.log(new Set(plain()).size, [...new Set(n)]);

class Tracked implements Iterable<string> {
  log: string[] = [];
  *[Symbol.iterator](): Generator<string> {
    try {
      for (const word of ["a", "b", "c"]) {
        this.log.push("yield " + word);
        yield word;
      }
    } finally {
      this.log.push("closed");
    }
  }
}
const t = new Tracked();
for (const w of t) {
  if (w === "b") break;
  t.log.push("saw " + w);
}
console.log(t.log.join(", "));
class Tree implements Iterable<number> {
  value: number;
  children: Tree[];
  constructor(value: number, children: Tree[] = []) {
    this.value = value;
    this.children = children;
  }
  *[Symbol.iterator](): Generator<number> {
    yield this.value;
    for (const child of this.children) yield* child;
  }
}
class Leafy extends Tree {}
const tree = new Tree(1, [new Tree(2, [new Tree(3)]), new Leafy(4)]);
console.log([...tree], Array.from(new Leafy(9)), Math.min(...tree));
