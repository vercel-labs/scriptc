// Untyped Maps, Sets and arrays whose uses prove their key, value and
// element types compile as typed collections; any other use keeps them
// untyped. Both must answer as Node does, including SameValueZero keys,
// lookups of another type, and every use that refuses the typing.

// Typed: counters, membership sets and stacks used only through their
// methods.
const counts = new Map();
const seen = new Set();
const stack = [];
const words = [];
for (let i = 0; i < 40; i++) {
  const key = "k" + (i % 7);
  counts.set(key, (counts.get(key) ?? 0) + 1);
  seen.add(i % 5);
  stack.push(i * 2);
  if (stack.length > 6) stack.shift();
  words.push(key);
}
console.log(counts.size, counts.get("k3"), counts.get("missing"), counts.has("k6"), counts.delete("k0"), counts.size);
console.log(seen.size, seen.has(4), seen.has(5), seen.delete(4), seen.has(4));
console.log(stack.length, stack.at(-1), stack.at(0), stack.pop(), stack.includes(70), stack.indexOf(72), words.join("|").length);

// SameValueZero keys and NaN elements on typed collections.
const byNumber = new Map();
byNumber.set(NaN, "nan");
byNumber.set(-0, "zero");
byNumber.set(1.5, "x");
console.log(byNumber.get(NaN), byNumber.get(0), byNumber.get(-0), byNumber.size, byNumber.has(1.5));
const nums = [];
nums.push(NaN);
nums.push(-0);
console.log(nums.includes(NaN), nums.indexOf(NaN), nums.includes(0), nums.indexOf(0));
const flags = new Set();
flags.add(true);
console.log(flags.has(true), flags.has(false), flags.size);

// Captured by a closure that only uses it.
const cache = new Map();
const latest = () => cache.get("c") ?? -1;
console.log(latest());
for (let i = 0; i < 3; i++) cache.set("c", i * 10);
console.log(latest(), cache.size);

// Lookups of another type: the typing refuses, and the answers stay Node's.
const strings = new Map();
strings.set("1", "one");
console.log(strings.get(1), strings.get("1"), strings.has(1));
const numbers = [];
numbers.push(1);
console.log(numbers.includes("1"), numbers.indexOf("1"), numbers.at("0"));

// Mixed key, value and element types.
const mixedKeys = new Map();
mixedKeys.set(1, "number");
mixedKeys.set("1", "string");
console.log(mixedKeys.size, mixedKeys.get(1), mixedKeys.get("1"));
const mixedValues = new Map();
mixedValues.set("a", 1);
mixedValues.set("b", "two");
console.log(mixedValues.get("a"), mixedValues.get("b"));
const mixedElements = [];
mixedElements.push(1);
mixedElements.push("two");
console.log(mixedElements.join(","), mixedElements.length);

// Escapes and other uses that keep the collection untyped.
const passed = new Map();
passed.set("x", 1);
function sizeOf(m) {
  return m.size;
}
console.log(sizeOf(passed));
function make() {
  const made = new Set();
  made.add("y");
  return made;
}
console.log(make().has("y"));
const stored = [];
stored.push(3);
const holder = { list: stored };
holder.list.push(4);
console.log(stored.length, holder.list.join("+"));
const iterated = new Map();
iterated.set("a", 1);
iterated.set("b", 2);
for (const [k, v] of iterated) console.log("entry", k, v);
const eachSet = new Set();
eachSet.add(3);
eachSet.forEach((v) => console.log("member", v));
const shown = new Map();
shown.set("s", 1);
console.log(shown);
const chained = new Map();
chained.set("a", 1).set("b", 2);
console.log(chained.size);
const optional = new Map();
optional.set("o", 1);
console.log(optional?.get("o"), optional.get?.("o"));
const indexed = [];
indexed.push(1);
indexed[3] = 2;
console.log(indexed.length, indexed.join(","));
const truncated = [];
truncated.push(1, 2, 3);
truncated.length = 1;
console.log(truncated.length, truncated.at(0));
const spread = [];
spread.push(5);
console.log(Math.max(...spread));
const unread = new Map();
console.log(unread.size, unread.get("none"));
export const exported = new Map();
exported.set("e", 1);
console.log(exported.get("e"));
// Exported through an export list, under its own name or another: an
// importer sees an untyped Map.
const listed = new Map();
listed.set("l", 1);
console.log(listed.get("l"));
const renamed = new Map();
renamed.set("r", 1);
console.log(renamed.get("r"));
export { listed, renamed as alias };
