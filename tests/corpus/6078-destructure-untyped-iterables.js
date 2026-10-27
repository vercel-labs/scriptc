// Array destructuring of untyped iterables: Map and Set objects, their
// iterators, compiled generators and objects with a Symbol.iterator method
// step through the iterator protocol, and an iterator with values left
// closes.
const m = new Map([["a", 1], ["b", 2], ["c", 3]]);
function two(it) { const [x, y] = it; return [x, y]; }
console.log(two(m), two(new Set([7, 8, 9])), two(m.keys()), two("hey"), two([1]));
function rest(it) { const [x, ...more] = it; return [x, more]; }
console.log(rest(m.values()), rest(new Set([1, 2, 3])), rest(m.entries()));
function* g() {
  try {
    yield 1;
    yield 2;
    yield 3;
  } finally {
    console.log("finally");
  }
}
console.log(two(g()), rest(g()));
function holes(it) { const [, b, , d] = it; return [b, d]; }
console.log(holes(g()));
function none(it) { const [] = it; return "none"; }
console.log(none(g()));
function* short() { yield "only"; }
console.log(two(short()));
const custom = {
  [Symbol.iterator]() {
    let i = 0;
    return {
      next: () => ({ value: i++, done: i > 5 }),
      return() {
        console.log("return called");
        return {};
      },
    };
  },
};
console.log(two(custom));
const helper = [1, 2, 3, 4].values().map((x) => x * 3);
console.log(two(helper), [...helper]);
for (const bad of [1, null, undefined, {}, true]) {
  try {
    two(bad);
  } catch (e) {
    console.log(e.name, e.message);
  }
}
const throwing = {
  [Symbol.iterator]() {
    return {
      next() { throw new Error("next failed"); },
      return() { console.log("not called"); return {}; },
    };
  },
};
try {
  two(throwing);
} catch (e) {
  console.log(e.message);
}
