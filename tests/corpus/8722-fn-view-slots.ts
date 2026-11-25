// A function held at a type with fewer parameters than it has, then at a
// type with more. JavaScript has one function object throughout, so the
// last call's arguments reach the function's own parameters whatever slots
// the value passed through: a record field, a reassigned binding, a
// parameter, a return slot, and chains that narrow and widen again.
function label(prefix: string, options?: { upper: boolean }): string {
  return options?.upper ? prefix.toUpperCase() : prefix;
}
function plain(prefix: string): string {
  return prefix + "!";
}
type One = (prefix: string) => string;
type Two = (prefix: string, options: { upper: boolean }) => string;

// A record field of one parameter, then a two-parameter slot.
interface Ops {
  make: One;
}
const ops: Ops = { make: label };
const fromField: Two = ops.make;
console.log("field", fromField("abc", { upper: true }), ops.make("abc"));

// Two const bindings.
const narrow: One = label;
const wide: Two = narrow;
console.log("const", wide("abc", { upper: true }), narrow("abc"));

// A reassigned binding holds a function that takes the options, then one
// that does not.
let current: One = plain;
if (process.argv.length < 100) current = label;
const first: Two = current;
current = plain;
const second: Two = current;
console.log("let", first("abc", { upper: true }), second("abc", { upper: true }), current("abc"));

// A parameter slot whose callee calls wider, and a return slot.
function callWide(f: Two): string {
  return f("abc", { upper: true });
}
function pass(f: One): string {
  return callWide(f);
}
function pick(): One {
  return label;
}
function widen(f: One): Two {
  return f;
}
function narrowOf(f: One): One {
  return f;
}
console.log("param", callWide(label), pass(label), pass(plain));
console.log("return", widen(pick())("abc", { upper: true }), widen(plain)("abc", { upper: true }));
const viaReturn: Two = pick();
console.log("return slot", viaReturn("abc", { upper: true }));

// Narrower, wider, narrower, wider: every hop is a slot of its own.
function join3(a: string, b?: string, c?: string): string {
  return [a, b, c].map((x) => (x === undefined ? "_" : x)).join("-");
}
function to1(f: (a: string) => string): (a: string) => string {
  return f;
}
function to2(f: (a: string) => string): (a: string, b: string) => string {
  return f;
}
function to3(f: (a: string, b: string) => string): (a: string, b: string, c: string) => string {
  return f;
}
function to4(f: (a: string) => string): (a: string, b: string, c: string, d: number) => string {
  return f;
}
console.log("chain", to1(join3)("a"), to2(to1(join3))("a", "b"), to3(to2(to1(join3)))("a", "b", "c"));
console.log("chain", to4(to1(join3))("a", "b", "c", 4), to4(join3)("a", "b", "c", 4));
// Wider first, then narrower, then wider again.
function opt3(f: (a: string, b?: string, c?: string, d?: number) => string): (a: string, b?: string, c?: string, d?: number) => string {
  return f;
}
console.log("chain", to2(to1(opt3(join3)))("a", "b"), to4(to1(opt3(join3)))("a", "b", "c", 4), opt3(join3)("a"));

// One function object: identity, name and length are the function's.
const n = narrowOf(label);
const w = widen(n);
console.log("identity", w === label, n === label, (w as unknown) === (n as unknown));
console.log("identity", label.length, n.length, w.length, n.name, w.name);
console.log("identity", new Set<unknown>([label, n, w, widen(pick())]).size);

// A function that really has the narrow parameter list ignores the rest.
console.log("honest", widen(narrowOf(plain))("abc", { upper: true }), widen((p) => p + "?")("abc", { upper: true }));

// The function's writes reach the caller's own array and record, through
// the narrow view and through the wide one.
interface Box {
  count: number;
}
function touch(items: string[], box: Box, extra?: string[], tally?: Box): number {
  items.push("pushed");
  box.count += 1;
  if (extra !== undefined) extra.push("extra");
  if (tally !== undefined) tally.count += 10;
  return items.length;
}
type Touch2 = (items: string[], box: Box) => number;
type Touch4 = (items: string[], box: Box, extra: string[], tally: Box) => number;
function narrowTouch(f: Touch2): Touch2 {
  return f;
}
function widenTouch(f: Touch2): Touch4 {
  return f;
}
const items = ["a"];
const box: Box = { count: 0 };
const extra: string[] = [];
const tally: Box = { count: 0 };
console.log("writes", narrowTouch(touch)(items, box), items.join(","), box.count);
console.log(
  "writes",
  widenTouch(narrowTouch(touch))(items, box, extra, tally),
  items.join(","),
  box.count,
  extra.join(","),
  tally.count,
);
