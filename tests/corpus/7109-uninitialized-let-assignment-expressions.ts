// A module `let` declared without an initializer is initialized (to
// undefined) when its declaration runs. Assignments in expression
// position store into it like assignment statements do.

// The deferred-resolver pattern: an expression-bodied executor.
let resolve!: (value: number) => void;
const pending = new Promise<number>((r) => (resolve = r));
resolve(1);
console.log("resolved", await pending);

// An expression-bodied setter, and the assignment's value.
let handler!: (n: number) => string;
const setHandler = (h: (n: number) => string) => (handler = h);
const returned = setHandler((n) => `handled ${n}`);
console.log(returned(2), handler(3));

// The value held in a binding first.
let next!: () => string;
const install = (f: () => string) => {
  const r = (next = f);
  return r;
};
console.log(install(() => "installed")(), next());

// Chained, conditional and argument positions.
let first!: (n: number) => number;
let second!: (n: number) => number;
first = second = (n) => n + 1;
console.log("chained", first(1), second(2));
let picked!: () => string;
const choose = (flag: boolean) => (flag ? (picked = () => "yes") : (picked = () => "no"));
choose(false);
console.log("conditional", picked());
const call = (f: () => string) => f();
let passed!: () => string;
console.log("argument", call((passed = () => "passed")), passed());

// Reassignment releases the earlier function and keeps the new one.
let counter!: () => number;
const make = (start: number) => {
  let n = start;
  return (counter = () => ++n);
};
make(10);
make(20);
console.log("reassigned", counter(), counter());

// An optional binding behaves the same way.
let maybe: ((s: string) => string) | undefined;
const setMaybe = (f: (s: string) => string) => (maybe = f);
console.log("optional", setMaybe((s) => s.toUpperCase())("a"), maybe?.("b"));

// A write that runs before the declaration still throws.
function early(): () => number {
  return (late = () => 1);
}
try {
  early();
} catch (e) {
  console.log((e as Error).name, (e as Error).message);
}
let late!: () => number;
console.log("after declaration", early()(), late());
