// The lib-fence battery: everything here TYPECHECKS against the real
// standard library (es2023) — the old minimal-ambient world rejected most
// of it with "Cannot find name" — and every statement must terminate in a
// clean lowering diagnostic (SC2020 for surface with no lowering, a
// specific fence otherwise). Never an ICE, never a silent mis-lowering.

// Globals as values and calls. (Symbol(desc) itself LOWERS now — the
// symbol battery lives in the corpus; what stays fenced is the well-known
// surface below.)
const iter = Symbol.iterator;
const g = globalThis;
const nan = NaN; // lowers now — a non-finite numeric literal like Infinity
const s5 = String(5);
const n5 = Number.NaN; // lowers now, with the other Number constants
const isArr = Array.isArray([1]);
const merged = Object.assign({}, { a: 1 }); // the empty-target literal-source shape lowers now (it IS the source literal)
const aliasedAssign = Object.assign(merged, { b: 2 }); // aliased targets stay fenced (real mutation of a live object)
const refl = Reflect.has({ a: 1 }, "a");
const parsedMs = Date.parse("2024-01-01");
const fmt = new Intl.NumberFormat();

// Constructors.
const d = new Date(2024, 0); // the local-time year/month field constructor stays fenced
const mutableDate = new Date(0);
mutableDate.setUTCFullYear(2024); // mutation is outside the read-only Date slice
const sameDate = mutableDate === mutableDate; // scalar storage must not fake object identity
const wm = new WeakMap();
const px = new Proxy({ a: 1 }, {});
const buf = new ArrayBuffer(8);
const st = new Set(new Set([1, 2])); // array seeds lower; Set/iterable seeds stay fenced
// (new Error / TypeError / RangeError / SyntaxError now LOWER — the error
// battery lives in the corpus; what stays fenced is the rest of the family
// and the unlowered members of lowered error objects.)
const agg = new AggregateError([]);
const stack = new Error("boom").stack;
// Unlowered members on lowered containers.
const sqrt2 = Math.SQRT2;
// (n-ary Math.min/max LOWER now — the variadic battery lives in the
// corpus; the mixed spread/positional list is the form that stays fenced.)
const clamped = Math.min(1, ...[2, 3]);
const entries = [1, 2].entries();
const arrAt = [1, 2].at(0);
const norm = "abc".normalize();
const limited = "a,b,c".split(Math.random() ? "," : /,/, 2); // union separators stay fenced; limits lower
const fixed = (1.5).toFixed(); // digit-free toFixed lowers now (the static ties-up integer)
const localized = (1234.5).toLocaleString();
// Unlowered call FORMS of lowered members. (push is fully variadic now —
// no fenced form remains to pin.)
const nums = [1, 2, 3];
const found = nums.indexOf(2, 1);
const joined = nums.join();
nums.forEach((x) => console.log(x), { unused: true }); // thisArg stays fenced
const pos = "abc".includes("b", 1); // the position form lowers now (indexOf's clamp)
const rev = JSON.parse("1", (_k, v) => v);
// (stringify with a null replacer + LITERAL space now lowers — the pretty
// battery lives in the corpus; function replacers and non-literal spaces
// stay fenced.)
const toStringify = { a: 1 };
const replaced = JSON.stringify(toStringify, (_k, v) => v);
const width = 2;
const spaced = JSON.stringify(toStringify, null, width);
// The promise surface beyond await.
async function work(): Promise<number> {
  return 1;
}
const thened = work().then((v) => v + 1, () => 0);
const caught = work().catch(() => 0);
const resolved = Promise.resolve(1);

// Object.is lowers over one comparable kind; the unlowered forms fence
// by name — a validate-first dynamic operand and partially-overlapping
// unions needing narrowing.
const dynIs = Object.is(JSON.parse("1") as unknown, 1);
function pick(a: string | number, b: number | boolean): boolean {
  return Object.is(a, b); // partially-overlapping unions: narrow first
}
const picked = pick(1, 2);

// Date values deliberately have no tagged-union payload yet. Nullable
// Date positions must fence in the frontend instead of reaching a backend
// scalar/ref mismatch.
function optionalDate(value: Date | undefined): number {
  return value === undefined ? -1 : value.getTime();
}
optionalDate(undefined);
// The binding is READ so the fence stays observable (an unread bigint
// declaration is a value Node builds and drops — it compiles to nothing).
const big = 10n;
console.log(big);
function throwDate(): void {
  throw new Date(0); // the exception cell cannot preserve Date's object kind
}
throwDate();
function* dateGenerator(): Generator<number, void, unknown> {
  yield 1;
}
dateGenerator().throw(new Date(0));
// End of the diagnostic fixture.
