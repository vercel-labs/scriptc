// A JavaScript module reads `length` of TypeScript functions that took
// their slot's signature. Where the box cannot name one declaration (a
// conditional, a rebound binding) the length is the value's own, read
// from the closure; a JavaScript function keeps its ExpectedArgumentCount
// there in another form, and the two must not be confused.
import { table, direct, declared, current, give } from "./slots.ts";

const never = process.argv.length > 99;
function plain(a, b, c, d) {}
function withDefault(a, b = 1, c) {}
function withRest(a, ...rest) {}
const show = (label, f) => console.log(label, f.length);

// One declaration, boxed as it is.
show("none", table.none);
show("one", table.one);
show("two", table.two);
show("all", table.all);
show("direct", direct);
show("declared", declared);
show("current", current());
show("give", give(true));
show("give", give(false));

// A conditional over a JavaScript function and a slot-typed one.
console.log("cond none", (never ? plain : table.none).length);
console.log("cond one", (never ? plain : table.one).length);
console.log("cond two", (never ? plain : table.two).length);
console.log("cond all", (never ? plain : table.all).length);
console.log("cond direct", (never ? plain : direct).length);
console.log("cond declared", (never ? plain : declared).length);
console.log("cond current", (never ? plain : current()).length);
console.log("cond give", (never ? plain : give(true)).length, (never ? plain : give(false)).length);
// The JavaScript arm taken.
console.log(
  "cond js",
  (never ? table.one : plain).length,
  (never ? table.one : withDefault).length,
  (never ? table.one : withRest).length,
);

// The same through bindings.
const pickNone = never ? plain : table.none;
const pickOne = never ? plain : table.one;
const pickTwo = never ? plain : table.two;
const pickAll = never ? plain : table.all;
console.log("const", pickNone.length, pickOne.length, pickTwo.length, pickAll.length);
let later = table.one;
if (!never) later = table.two;
console.log("let", later.length);
later = withDefault;
console.log("let", later.length);
later = give(false);
console.log("let", later.length);
function lengthOf(f) {
  return f.length;
}
console.log("param", lengthOf(table.two), lengthOf(never ? plain : table.two), lengthOf(withRest));
const list = [table.none, table.one, table.two, table.all, plain, withRest];
console.log("list", list.map((f) => f.length).join(","));

// The descriptor path and bound functions.
console.log("descriptor", Object.getOwnPropertyDescriptor(pickTwo, "length").value);
console.log("bound", table.two.bind(null).length, table.two.bind(null, 1).length, plain.bind(null, 1).length);

// Identity and calls are what they were.
console.log(table.one === table.one, pickOne === table.one, pickTwo === table.two);
console.log(table.two(1, 2, 3), pickTwo(1, 2, 3), pickAll(1, 2, 3), give(true)(7, 8, 9));
