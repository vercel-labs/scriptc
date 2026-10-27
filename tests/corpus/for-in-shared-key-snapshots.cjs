"use strict";
// for-in over plain objects that share a key sequence: each loop sees its
// own object's keys in order, including integer-like keys first, keys
// deleted or added during the walk, non-enumerable and accessor keys, and
// objects whose key set changes between loops.
function keys(o) {
  const out = [];
  for (const k in o) out.push(k);
  return out.join(",");
}
function make(a, b) {
  return { type: a, props: b, key: null };
}
const xs = [make(1, 2), make("x", "y"), make(null, undefined)];
for (const o of xs) console.log(keys(o));
const ints = { b: 1, 2: "two", a: 3, 1: "one" };
console.log(keys(ints), keys({ b: 1, 2: "two", a: 3, 1: "one" }));
const grow = make(1, 2);
grow.extra = 4;
console.log(keys(grow), keys(make(5, 6)));
const shrink = make(1, 2);
delete shrink.props;
console.log(keys(shrink));
const visited = [];
const live = make(1, 2);
for (const k in live) {
  visited.push(k);
  if (k === "type") delete live.key;
  if (k === "props") live.late = 1;
}
console.log(visited.join(","), keys(live));
const hidden = make(1, 2);
Object.defineProperty(hidden, "props", { enumerable: false });
console.log(keys(hidden), keys(make(3, 4)));
const withGetter = { type: 1, get props() { return 2; }, key: null };
console.log(keys(withGetter));
const inherited = Object.create({ base: 1 });
inherited.type = 1;
console.log(keys(inherited));
let total = 0;
for (let i = 0; i < 2000; i++) for (const k in xs[i % 3]) total += k.length;
console.log(total);
