// Three static families in one program: Object.entries/values over
// unit-armed (null | undefined) fields, RegExp values as array elements,
// and JSON.stringify over a dyn root holding undefined — all byte-exact
// against Node through LLVM.
//
// ── Object.entries/values over shapes whose fields are `null | undefined` —
// the mixed-defaults spread idiom (`{ ...defaults, ...overrides }` where a
// default is null and the merged field types optional): a unit-armed field
// with null as its ONE value arm pushes the null literal, guarded by the
// field's presence (an unset optional never made it into the object).
interface MergedDefaults {
  rangeStart: number;
  parser: string;
  endOfLine?: null;
  cursorOffset?: null;
}

const base = { rangeStart: 0, parser: "babel" };
const withNulls: MergedDefaults = { ...base, endOfLine: null };

for (const [k, v] of Object.entries(withNulls)) {
  console.log(k, String(v));
}
console.log("--");
for (const v of Object.values(withNulls)) {
  console.log(String(v));
}

// Both unit-armed fields present: each pushes its null.
const bothSet: MergedDefaults = { rangeStart: 3, parser: "flow", endOfLine: null, cursorOffset: null };
console.log(Object.entries(bothSet).length, Object.values(bothSet).length);
for (const [k, v] of Object.entries(bothSet)) {
  console.log(`${k}=${String(v)}`);
}

// Neither present: the presence guard skips both keys, exactly Node's
// missing-key answer for unset optionals.
const noneSet: MergedDefaults = { rangeStart: 7, parser: "meriyah" };
console.log(Object.keys(noneSet).join(","));
console.log(Object.entries(noneSet).length);

// The defaults-merge shape over the entries — the consuming idiom: each
// [key, value] pair flows through destructuring into ordinary statics.
const seen: string[] = [];
for (const [k, v] of Object.entries(withNulls)) {
  seen.push(v === null ? `${k}:<null>` : `${k}:${String(v)}`);
}
console.log(seen.join(" "));

// ── RegExp values as ARRAY elements — the derived-pattern idiom: a base
// word list maps into compiled patterns (`[bases].map(ps => new
// ── RegExp(...))`), the array destructures, elements test/match like any
// regex value, and indexOf/includes/=== are object identity, exactly JS.
const PRAGMAS = ["format", "prettier"];
const IGNORE_PRAGMAS = PRAGMAS.map((p) => `no${p}`);

const [HAS_PRAGMA, HAS_IGNORE_PRAGMA] = [PRAGMAS, IGNORE_PRAGMAS].map(
  (pragmas) => new RegExp(`^\\s*@(?:${pragmas.join("|")})\\b`),
);
console.log(HAS_PRAGMA.test("  @format now"));
console.log(HAS_PRAGMA.test("  @noformat now"));
console.log(HAS_IGNORE_PRAGMA.test("  @noprettier"));
console.log(HAS_PRAGMA.source);

// Literal regex arrays: reads, length, for-of, and source/flags on the
// elements.
const checks: RegExp[] = [/^a+$/u, /b|c/, /end$/m];
console.log(checks.length);
for (const re of checks) {
  console.log(re.source, re.flags, re.test("aaa"));
}
console.log(checks[1].test("xbx"), checks[2].test("the end"));

// Identity semantics: indexOf/includes compare references, like JS.
// (Two same-source LITERALS share one interned instance here where JS
// mints fresh objects — the documented interning divergence — so the
// fixture pins identity through the same reference only.)
const first = checks[0];
console.log(checks.indexOf(first), checks.includes(first));
console.log(checks.indexOf(HAS_PRAGMA)); // a different regex object: absent

// push/pop keep the element home honest.
const grown: RegExp[] = [];
grown.push(/one/, /two/);
console.log(grown.length, grown[0].source);
const popped = grown.pop();
console.log(popped === undefined ? "none" : popped.source, grown.length);

// ── JSON.stringify over a dyn root holding undefined ─────────────────────
// JSON.stringify(undefined) is the undefined VALUE; printing it spells the
// word — the dyn walker handles both paths (a nested-position writer
// would spell null; the root is special).
const u: unknown = undefined;
console.log(JSON.stringify(u));
const held: unknown = { a: undefined, b: 1 };
console.log(JSON.stringify(held));
const nested: unknown = { list: [1, null], t: true };
console.log(JSON.stringify(nested));
