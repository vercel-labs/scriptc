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
// fence for them here); what keeps the SC1101 fence is a type with no
// dyn representation (Maps, classes, bytes).
const typedIntoUnknown: unknown = new Map<string, number>();
function wantsUnknown(x: unknown): void {}
wantsUnknown(new Map<string, number>());
const stringifyClosure = JSON.stringify((x: number) => x + 1);
class Point {
  x: number = 0;
}
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
  data: unknown = JSON.parse("{}"); // unknown class fields compile as dyn storage now — no fence
}
const anything: any = 5; // checker-`any` bindings ride the checked-dynamic tree now — no fence
const dynArray: unknown[] = []; // unknown[] IS the dyn array now — no fence (corpus 2585)
const parseRef = JSON.parse;
// BARE undefined-armed unions are not JSON on the STRINGIFY side: Node
// stringifies bare undefined to a non-string. (The cast direction
// `u as string | undefined` compiles now — the checked-dynamic tree holds a first-class
// undefined value for index-signature overflow reads, and the undefined
// arm matches exactly it.)
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
