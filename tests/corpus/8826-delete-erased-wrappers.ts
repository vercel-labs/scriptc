// Node erases every type-level wrapper, so a member `delete` names the object
// the innermost operand names whatever is wrapped around it: `as`, a
// non-null assertion, `satisfies`, parentheses, in any order. A receiver
// test that looks only at the outermost node misses an assertion under a
// `!` or a `satisfies`, lowers the asserted expression, and deletes from
// the assertion's converted copy: the member stays, with no diagnostic. An
// operand that may be undefined or null converts into the same copy once the
// assertion drops the unit arm. Both now delete in place, and a nullish
// receiver throws the TypeError Node's ToObject gives a `delete`.
// (tests/corpus/8990-delete-asserted-record.ts pins the plain `as` chain.)
interface Opt {
  a?: number;
  b: number;
}
type View = { a?: number };

function show(label: string, value: Opt): void {
  console.log(label, "a" in value, value.a, Object.keys(value), JSON.stringify(value));
}

// A non-null assertion around the assertion.
const outer: Opt = { a: 1, b: 2 };
delete (outer as View)!.a;
show("nonnull outer", outer);

// `satisfies` around the assertion, and under it.
const satisfiesOuter: Opt = { a: 1, b: 2 };
delete ((satisfiesOuter as View) satisfies View).a;
show("satisfies outer", satisfiesOuter);
const satisfiesInner: Opt = { a: 1, b: 2 };
delete (satisfiesInner satisfies Opt as View).a;
show("satisfies inner", satisfiesInner);

// Wrappers with no assertion keep the ordinary delete.
const plain: Opt = { a: 1, b: 2 };
delete (plain satisfies Opt).a;
show("satisfies only", plain);
const parenthesized: Opt = { a: 1, b: 2 };
delete ((parenthesized)).a;
show("parentheses", parenthesized);

// Value position answers Node's boolean and deletes in place too.
const valued: Opt = { a: 1, b: 2 };
const first = delete (valued as View)!.a;
const second = delete ((valued as View) satisfies View).a;
console.log("value", first, second);
show("value after", valued);

// Bracket keys through the same wrappers.
const bracket: Opt = { a: 1, b: 2 };
delete (bracket as View)!["a"];
show("bracket", bracket);

// `as any` and `as unknown as` are assertions like any other.
const viaAny: Opt = { a: 1, b: 2 };
delete (viaAny as any).a;
show("any", viaAny);
const viaAnyBracket: Opt = { a: 1, b: 2 };
delete (viaAnyBracket as any)["a"];
show("any bracket", viaAnyBracket);
const viaAnyChain: Opt = { a: 1, b: 2 };
delete (viaAnyChain as any as View)!.a;
show("any chain", viaAnyChain);

// An operand that may be undefined or null: the assertion drops the unit
// arm, and the delete still lands on the stored object.
function maybe(flag: boolean): Opt | undefined {
  return flag ? { a: 1, b: 2 } : undefined;
}
function nullable(flag: boolean): Opt | null {
  return flag ? { a: 1, b: 2 } : null;
}
const optional = maybe(true);
delete (optional as View).a;
show("optional", optional!);
const optionalNonNull = maybe(true);
delete (optionalNonNull as View)!.a;
show("optional nonnull outer", optionalNonNull!);
const innerNonNull = maybe(true);
delete (innerNonNull! as View).a;
show("optional nonnull inner", innerNonNull!);
const fromNull = nullable(true);
delete (fromNull as View).a;
show("nullable", fromNull!);
const optionalValue = maybe(true);
console.log("optional value", delete (optionalValue as View).a);
show("optional value after", optionalValue!);

// The operand is evaluated once, and it is the object the delete changes.
let calls = 0;
const shared: Opt = { a: 1, b: 2 };
function get(): Opt | undefined {
  calls++;
  return shared;
}
delete (get() as View).a;
show("call", shared);
shared.a = 5;
console.log("call value", delete (get() as View)!.a, calls);
show("call value after", shared);

// Elements, map entries, fields and tuple slots.
const list: Opt[] = [{ a: 1, b: 2 }];
delete (list[0] as View).a;
show("element", list[0]!);
const entries = new Map<string, Opt>([["k", { a: 1, b: 2 }]]);
delete (entries.get("k") as View).a;
show("map entry", entries.get("k")!);
const holder: { inner?: Opt } = { inner: { a: 1, b: 2 } };
delete (holder.inner as View).a;
show("optional field", holder.inner!);

// Function locals take the same rule.
function local(): void {
  const one: Opt = { a: 1, b: 2 };
  delete (one as View)!.a;
  show("local nonnull outer", one);
  const two = maybe(true);
  delete (two as View).a;
  show("local optional", two!);
  const three = maybe(true);
  const gone = delete ((three as View) satisfies View).a;
  console.log("local value", gone);
  show("local value after", three!);
}
local();

// A nullish receiver throws what Node's ToObject throws for a `delete`:
// neither the receiver nor the key is named.
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
attempt("undefined statement", () => {
  delete (missing as View).a;
});
attempt("undefined value", () => {
  console.log(delete (missing as View).a);
});
attempt("undefined nonnull outer", () => {
  delete (missing as View)!.a;
});
attempt("undefined nonnull", () => {
  delete missing!.a;
});
attempt("undefined nonnull bracket", () => {
  delete missing!["a"];
});
attempt("null statement", () => {
  delete (missingNull as View).a;
});
attempt("null nonnull", () => {
  delete missingNull!.a;
});
attempt("local undefined", () => {
  const none = maybe(false);
  delete (none as View).a;
});
attempt("call undefined", () => {
  delete (maybe(false) as View).a;
});
attempt("element undefined", () => {
  const empty: Opt[] = [];
  delete (empty[0] as View).a;
});
// A key the operand's type does not declare lives in the kept source a
// checked record notes from the value it was converted from
// (tests/corpus/8998-delete-undeclared-record-key.ts). The wrappers address
// that same record, so the delete removes the key there through each of them.
interface Kept {
  model: string;
}
type KeptWide = { model: string; max_tokens?: number };
function parseKept(): Kept {
  return JSON.parse('{"model":"m","max_tokens":5,"z":1}') as Kept;
}
function showKept(label: string, value: Kept): void {
  console.log(label, "max_tokens" in value, Object.keys(value).join(","), JSON.stringify(value));
}
const keptNonNull = parseKept();
delete (keptNonNull as KeptWide)!.max_tokens;
showKept("kept nonnull outer", keptNonNull);
const keptSatisfies = parseKept();
console.log(delete ((keptSatisfies as KeptWide) satisfies KeptWide).max_tokens);
showKept("kept satisfies outer", keptSatisfies);
const keptAny = parseKept();
delete (keptAny as any).max_tokens;
showKept("kept any", keptAny);
const keptBracket = parseKept();
console.log(delete (keptBracket as unknown as KeptWide)["max_tokens"]);
showKept("kept unknown chain bracket", keptBracket);
// A key the record never held: `true`, and nothing changes.
const keptMissing = parseKept();
console.log(delete (keptMissing as { model: string; nope?: number })!.nope);
showKept("kept missing key", keptMissing);
// An operand that may be undefined is narrowed to its record first.
function maybeKept(present: boolean): Kept | undefined {
  return present ? parseKept() : undefined;
}
const keptOptional = maybeKept(true);
delete (keptOptional as KeptWide).max_tokens;
if (keptOptional !== undefined) showKept("kept optional", keptOptional);
const keptOptionalValue = maybeKept(true);
const keptGone = delete (keptOptionalValue as KeptWide)!.max_tokens;
if (keptOptionalValue !== undefined) showKept(`kept optional value ${keptGone}`, keptOptionalValue);
attempt("kept undefined", () => {
  delete (maybeKept(false) as KeptWide).max_tokens;
});
// The operand is evaluated once.
let keptCalls = 0;
function keptOnce(): Kept {
  keptCalls++;
  return parseKept();
}
console.log(delete (keptOnce() as KeptWide)!.max_tokens, keptCalls);
export {};
