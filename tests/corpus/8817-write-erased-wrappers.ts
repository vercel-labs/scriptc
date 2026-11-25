// Node erases every type-level wrapper, so a member write through
// `(value as View)` changes the object `value` names, whatever else is
// wrapped around the assertion and however the member is spelled. A record
// assertion that changes layout lowers to a converted copy, and the write
// rule that addresses the operand instead used to look only at an `as`
// directly under the member access with a dot: a non-null assertion or a
// `satisfies` around the assertion, an operand that may be undefined or
// null, and a bracket key each fell back to the copy, where the write was
// dropped with no diagnostic. All of them now write the operand in place.
// (tests/corpus/8826-delete-erased-wrappers.ts is the `delete` twin; the
// keyed forms with no in-place answer are refused by name in
// tests/diagnostics/keyed-write-asserted-copy.ts.)
interface Opt {
  a?: number;
  b: number;
}
type View = { a?: number };
type Count = { b: number };

function show(label: string, value: Opt): void {
  console.log(label, value.a, value.b, Object.keys(value), JSON.stringify(value));
}

// A non-null assertion or `satisfies` around the assertion.
const outer: Opt = { a: 1, b: 2 };
(outer as View)!.a = 5;
show("nonnull outer", outer);
const satisfiesOuter: Opt = { a: 1, b: 2 };
((satisfiesOuter as View) satisfies View).a = 5;
show("satisfies outer", satisfiesOuter);
const satisfiesInner: Opt = { a: 1, b: 2 };
(satisfiesInner satisfies Opt as View).a = 5;
show("satisfies inner", satisfiesInner);

// Updates read and write the same object.
const compound: Opt = { a: 1, b: 2 };
(compound as Count)!.b += 5;
show("compound", compound);
const increment: Opt = { a: 1, b: 2 };
(increment as Count)!.b++;
show("increment", increment);
const coalesce: Opt = { b: 2 };
(coalesce as View)!.a ??= 7;
show("coalesce", coalesce);

// A write makes a deleted optional member present again.
const readded: Opt = { b: 2 };
(readded as View)!.a = 3;
console.log("readded", "a" in readded, Object.keys(readded));

// Bracket keys name the same member.
const bracket: Opt = { a: 1, b: 2 };
(bracket as View)["a"] = 5;
show("bracket", bracket);
const bracketOuter: Opt = { a: 1, b: 2 };
(bracketOuter as View)!["a"] = 6;
show("bracket nonnull outer", bracketOuter);
const literal: Opt = { a: 1, b: 2 };
const key = "a";
(literal as View)[key] = 7;
show("bracket literal binding", literal);

// An assertion to the value's own layout converts nothing, with any key.
const dict: Record<string, number> = { x: 1 };
(dict as Record<string, number>)["y"] = 2;
const name: string = "z";
(dict as Record<string, number>)[name] = 3;
console.log("same layout", Object.keys(dict), JSON.stringify(dict));

// An operand that may be undefined or null: the assertion drops the unit
// arm, and the write still lands on the stored object.
function maybe(flag: boolean): Opt | undefined {
  return flag ? { a: 1, b: 2 } : undefined;
}
function nullable(flag: boolean): Opt | null {
  return flag ? { a: 1, b: 2 } : null;
}
const optional = maybe(true);
(optional as View).a = 5;
show("optional", optional!);
const optionalOuter = maybe(true);
(optionalOuter as View)!.a = 6;
show("optional nonnull outer", optionalOuter!);
const optionalBracket = maybe(true);
(optionalBracket as View)["a"] = 7;
show("optional bracket", optionalBracket!);
const optionalCompound = maybe(true);
(optionalCompound as Count).b += 5;
show("optional compound", optionalCompound!);
const fromNull = nullable(true);
(fromNull as View).a = 8;
show("nullable", fromNull!);

// The operand is evaluated once.
let calls = 0;
const shared: Opt = { a: 1, b: 2 };
function get(): Opt | undefined {
  calls++;
  return shared;
}
(get() as View).a = 9;
(get() as Count)!.b += 1;
(get() as View)["a"] = 10;
console.log("calls", calls);
show("call", shared);

// Elements, map entries and optional fields.
const list: Opt[] = [{ a: 1, b: 2 }];
(list[0] as View).a = 11;
show("element", list[0]!);
const entries = new Map<string, Opt>([["k", { a: 1, b: 2 }]]);
(entries.get("k") as View).a = 12;
show("map entry", entries.get("k")!);
const holder: { inner?: Opt } = { inner: { a: 1, b: 2 } };
(holder.inner as View).a = 13;
show("optional field", holder.inner!);

// Function locals take the same rule.
function local(): void {
  const one: Opt = { a: 1, b: 2 };
  (one as View)!.a = 14;
  show("local nonnull outer", one);
  const two = maybe(true);
  (two as View).a = 15;
  show("local optional", two!);
  const three = maybe(true);
  (three as View)["a"] = 16;
  show("local optional bracket", three!);
}
local();

// A nullish receiver throws Node's TypeError for the operation: a plain
// assignment never reads the member, an update reads it first.
function attempt(label: string, run: () => void): void {
  try {
    run();
    console.log(label, "no throw");
  } catch (e) {
    console.log(label, (e as Error).name, (e as Error).message);
  }
}
const missing = maybe(false);
const missingNull = nullable(false);
attempt("undefined write", () => {
  (missing as View).a = 1;
});
attempt("undefined bracket write", () => {
  (missing as View)["a"] = 1;
});
attempt("undefined compound", () => {
  (missing as Count).b += 1;
});
attempt("null write", () => {
  (missingNull as View).a = 1;
});
attempt("null compound", () => {
  (missingNull as Count).b += 1;
});
attempt("local undefined write", () => {
  const none = maybe(false);
  (none as View).a = 1;
});
attempt("call undefined write", () => {
  (maybe(false) as View).a = 1;
});

// A plain keyed assignment evaluates its right-hand side before it needs an
// object to write to: a nullish receiver throws after the value's side
// effects ran, and a present one is written once. (A binding that may be
// undefined still checks first, like `binding!.a = value()` does.)
let evaluated = 0;
function next(): number {
  evaluated++;
  return 7;
}
function ordered(label: string, run: () => void): void {
  const before = evaluated;
  try {
    run();
    console.log(label, "no throw", evaluated - before);
  } catch (e) {
    console.log(label, (e as Error).message, evaluated - before);
  }
}
const holes: (Opt | undefined)[] = [undefined, { a: 1, b: 2 }];
ordered("binding null bracket order", () => {
  (missingNull as View)["a"] = next();
});
ordered("call undefined bracket order", () => {
  (maybe(false) as View)["a"] = next();
});
ordered("element undefined bracket order", () => {
  (holes[0] as View)["a"] = next();
});
ordered("nonnull outer call undefined bracket order", () => {
  (maybe(false) as View)!["a"] = next();
});
ordered("call null bracket order", () => {
  (nullable(false) as View)["a"] = next();
});
ordered("element present bracket order", () => {
  (holes[1] as View)["a"] = next();
});
show("element present bracket", holes[1]!);
const orderedPresent = maybe(true);
ordered("binding present bracket order", () => {
  (orderedPresent as View)["a"] = next();
});
show("binding present bracket", orderedPresent!);

// An own property written through a compiled Error subclass keeps Node's
// answers through the same wrappers
// (tests/corpus/8843-error-subclass-own-property.ts pins the plain form).
class HttpError extends Error {}
type WithHeaders = Error & { headers?: string };
const viaNonNull = new HttpError("x");
(viaNonNull as WithHeaders)!.headers = "h";
console.log(
  "error nonnull outer",
  Object.prototype.hasOwnProperty.call(viaNonNull, "headers"),
  (viaNonNull as WithHeaders).headers,
  "headers" in viaNonNull,
);
const viaSatisfies = new HttpError("y");
((viaSatisfies as WithHeaders) satisfies WithHeaders).headers = "h";
console.log(
  "error satisfies outer",
  Object.prototype.hasOwnProperty.call(viaSatisfies, "headers"),
  (viaSatisfies as WithHeaders).headers,
);
const viaBracket = new HttpError("z");
(viaBracket as WithHeaders)["headers"] = "h";
console.log(
  "error bracket",
  Object.prototype.hasOwnProperty.call(viaBracket, "headers"),
  (viaBracket as WithHeaders).headers,
);
export {};
