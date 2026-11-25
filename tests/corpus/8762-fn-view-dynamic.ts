// A function held at a narrower function type, then reached through an
// untyped value, an assertion or a bound function: `any` and `unknown`
// hold the function itself, so a dynamic call or a conversion back to a
// wider type hands it every argument, and a call through an assertion to a
// wider type evaluates and passes the extra arguments.
function label(prefix: string, options?: { upper: boolean }): string {
  return options?.upper ? prefix.toUpperCase() : prefix;
}
function plain(prefix: string): string {
  return prefix + "!";
}
type One = (prefix: string) => string;
type Two = (prefix: string, options: { upper: boolean }) => string;
function narrowOf(f: One): One {
  return f;
}
const up = { upper: true };

// Through any: converted back to a wider type, and called dynamically.
const loose: any = narrowOf(label);
const fromLoose: Two = loose;
console.log("any", fromLoose("abc", up), loose("abc", up), loose("abc"));
const looseHonest: any = narrowOf(plain);
console.log("any", looseHonest("abc", up), (looseHonest as Two)("abc", up));

// Through unknown and an assertion; an element of unknown[].
const hidden: unknown = narrowOf(label);
const boxed: unknown[] = [narrowOf(label), narrowOf(plain)];
console.log("unknown", (hidden as Two)("abc", up), (boxed[0] as Two)("abc", up), (boxed[1] as Two)("abc", up));
console.log("unknown", hidden === label, boxed[0] === hidden, typeof hidden);

// A call through an assertion to the wider type: the extra argument is
// evaluated once and passed.
let made = 0;
function opts(): { upper: boolean } {
  made++;
  return { upper: true };
}
const n = narrowOf(label);
console.log("assert", (n as Two)("abc", up), (n as Two)("abc", opts()), made);
console.log("assert", (narrowOf(plain) as Two)("abc", up), (narrowOf(plain) as Two)("abc", opts()), made);
const kept = n as Two;
console.log("assert", kept("abc", up), (kept as unknown) === (label as unknown));

// A bound method. (A partial application stored under a fixed signature and
// then widened is a stored variadic function: refused by name, below.)
class Maker {
  suffix = "!";
  make(prefix: string, options?: { upper: boolean }): string {
    return (options?.upper ? prefix.toUpperCase() : prefix) + this.suffix;
  }
}
const maker = new Maker();
const bound: One = maker.make.bind(maker);
const wideBound: Two = bound;
console.log("bind", wideBound("abc", up), bound("abc"));

// (A rest or `arguments` function stored under a fixed signature and then
// handed to a caller that passes more is refused by name, SC1090: the rule
// of variadic-functions.ts, pinned by
// tests/diagnostics/variadic-store-longer-call.ts.)

// Writes through a dynamic call and through an assertion reach the
// caller's own array and record.
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
const items = ["a"];
const box: Box = { count: 0 };
const extra: string[] = [];
const tally: Box = { count: 0 };
const looseTouch: any = narrowTouch(touch);
console.log("writes", looseTouch(items, box, extra, tally), items.join(","), box.count, extra.join(","), tally.count);
console.log(
  "writes",
  (narrowTouch(touch) as Touch4)(items, box, extra, tally),
  items.join(","),
  box.count,
  extra.join(","),
  tally.count,
);
