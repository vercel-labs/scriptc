"use strict";
// for...of, spread and destructuring over untyped arrays: elements are read
// live, so pushes and truncation during the loop show, holes read as
// undefined, an own Symbol.iterator replaces the builtin one, and keys()
// and entries() keep their own shapes, as in Node.

/** @param {any} list */
function collect(list) {
  const out = [];
  for (const item of list) out.push(item);
  return out;
}

/** @param {any} list */
function growWhileIterating(list) {
  const seen = [];
  for (const item of list) {
    seen.push(item);
    if (item === 2) list.push(99);
    if (seen.length > 10) break;
  }
  return seen;
}

/** @param {any} list */
function shrinkWhileIterating(list) {
  const seen = [];
  for (const item of list) {
    seen.push(item);
    list.length = 2;
  }
  return seen;
}

const parsed = JSON.parse('[1, "two", {"three": 3}, [4], null, true]');
console.log(JSON.stringify(collect(parsed)));
console.log(JSON.stringify(collect([])));
console.log(JSON.stringify(growWhileIterating(JSON.parse("[1, 2, 3]"))));
console.log(JSON.stringify(shrinkWhileIterating(JSON.parse("[1, 2, 3, 4, 5]"))));

/** @type {any} */
const holes = [1, , 3];
holes.length = 5;
console.log(collect(holes).map((x) => String(x)).join(","));

/** @type {any} */
const custom = JSON.parse("[1, 2, 3]");
custom[Symbol.iterator] = function* () {
  yield "custom";
  yield this.length;
};
console.log(JSON.stringify(collect(custom)));

/** @type {any} */
const data = JSON.parse('[10, 20, 30]');
console.log(JSON.stringify([...data]), JSON.stringify([...data.keys()]), JSON.stringify([...data.entries()]));
const [first, , third = "default", fourth = "missing"] = data;
console.log(first, third, fourth);

let total = 0;
for (const value of data) {
  if (value === 20) continue;
  total += value;
}
console.log(total);

/** @param {any} list */
function nested(list) {
  const pairs = [];
  for (const a of list) for (const b of list) pairs.push(`${a}${b}`);
  return pairs.join(" ");
}
console.log(nested(JSON.parse('["x", "y"]')));

/** @param {any} list */
function earlyReturn(list) {
  for (const item of list) if (item > 1) return item;
  return -1;
}
console.log(earlyReturn(JSON.parse("[0, 1, 2, 3]")), earlyReturn(JSON.parse("[0]")));

try {
  console.log(collect(null));
} catch (e) {
  console.log(e instanceof TypeError, e.message);
}
