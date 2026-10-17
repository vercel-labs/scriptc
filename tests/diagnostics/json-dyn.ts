// The dyn ('unknown') fences: JSON.parse results support store/pass/cast,
// String()/template conversion, typeof/unit narrowing, truthiness (corpus
// 1539), keyed reads and 'in' (corpus 1544), strict equality against
// scalars AND other dyn values (whole-dyn ===), and logical operators
// (ToBoolean over the dyn kind), and `throw` (the dyn node rides the
// exception cell by reference) — those compile now and pin nothing; what
// remains outside is rejected specifically, pointing at the checked cast.
const u = JSON.parse("[1,2]");
console.log(JSON.parse("1") === JSON.parse("1"));
const both = JSON.parse("1") && JSON.parse("2");
console.log(`value: ${JSON.parse("3")}`);
switch (JSON.parse("5")) {
  case 5:
    break;
}
// JSON-safe typed values convert INTO 'unknown' slots now (dynFrom, a deep
// copy — differential corpus), and FUNCTIONS box as the checked-dynamic tree's callable
// kind (the checked-dynamic function boundary — corpus 1650-1654, so no
// fence for them here); program class instances and native handles now
// preserve identity through typed-reference boxes. Maps remain outside the
// dyn representation.
const typedIntoUnknown: unknown = new Map<string, number>();
function wantsUnknown(x: unknown): void {}
wantsUnknown(new Map<string, number>());
const stringifyClosure = JSON.stringify((x: number) => x + 1);
class Point {
  x: number = 0;
}
// This now compiles to a checked class-brand test. If reached, the plain
// parsed object throws instead of impersonating a Point; dyncheck.test.ts
// pins that scriptc-only failure behavior.
const intoClass = JSON.parse("{}") as Point;
// (casts of unknown to ADAPTABLE function types compile now — the kind
// check throws at runtime on non-function values; dyncheck.test.ts.
// Function-LOCAL dyn values captured by nested closures compile too —
// an untraced obj-box — so localCapture below diagnoses nothing.)
function localCapture(): () => number {
  const local = JSON.parse("1");
  return () => local as number;
}
class Holder {
  data: unknown = JSON.parse("{}"); // an `unknown` field stores the checked-dynamic value now — no fence (corpus 4944)
}
const anything: any = 5; // checker-`any` bindings ride the checked-dynamic tree now — no fence
const dynArray: unknown[] = []; // unknown[] IS the dyn array now — no fence (corpus 2585)
const parseRef = JSON.parse;
// The exact `string | undefined` root now lowers: strings serialize while
// undefined remains the undefined value, matching Node. Other bare
// undefined-armed root unions remain fenced until their root-level result
// can preserve undefined. Optional record fields still drop from serialized
// output like Node's.
function mkMaybe(): string | undefined {
  return undefined;
}
const stringifyUndef = JSON.stringify(mkMaybe());

// Reached: unreached bodies never lower, so their rejections only exist
// when something on the entry path uses them.
localCapture();

// Reached: collection defers its diagnostics until a reference makes
// them relevant; these references are what makes them count.
new Holder();
// End with a nonblank context line so diagnostic snapshots carry no trailing whitespace.
