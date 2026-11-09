// `a && b`, `a || b` and `a ?? b` whose right operand is a fresh object or
// array literal that builds at its contextual type while the checker types
// the pair by the literal's own, narrower type: `{ a: null }` answered as
// `{ a: string | null } | null`. The pair answers the literal, as built.

type Two = { units: string | null; length: string | null };
type Three = { units: string | null; length: string | null; unitsLength: string | null };
type Pair = { a: string | null; b: string | null };
type Other = { name: string };
type Cell = { v: string | null; w: string | null };

function checks(n: number): Two | null {
  if (n < 0) return null;
  return { units: n > 1 ? "u" + n : null, length: "l" + n };
}

// The form a guard takes: every check passed, so a record of nulls answers.
function guard(n: number): Three | null {
  const c = checks(n);
  return c && { units: null, length: null, unitsLength: null };
}
function guardTwo(n: number): Three | null {
  const bytes = checks(n);
  const units = checks(n + 1);
  return bytes && units && { units: units.units, length: bytes.length, unitsLength: units.length };
}

function mk(n: number): Other | null {
  return n < 0 ? null : { name: "n" + n };
}

function andNull(c: Other | null): Pair | null {
  return c && { a: null, b: null };
}
function andStr(c: Other | null): Pair | null {
  return c && { a: "x", b: "y" };
}
function andMixed(c: Other | null): Pair | null {
  return c && { a: "x", b: null };
}
function andSame(c: Other | null, s: string | null): Pair | null {
  return c && { a: s, b: s };
}
function andParen(c: Other | null): Pair | null {
  return c && ({ a: null, b: null });
}
function andChain(c: Other | null, d: Other | null): Pair | null {
  return c && d && { a: null, b: null };
}
function andOr(c: Other | null, d: Pair | null): Pair | null {
  return (c && { a: null, b: null }) || d;
}
function andDeclared(c: Other | null): string {
  const r: Pair | null = c && { a: null, b: null };
  return r === null ? "null" : `${r.a}/${r.b}`;
}
function take(r: Pair | null): string {
  return r === null ? "null" : `${r.a}/${r.b}`;
}
function andArgument(c: Other | null): string {
  return take(c && { a: null, b: null });
}
function andArray(c: Other | null): (string | null)[] | null {
  return c && [null, null];
}
function andNumberArray(c: Other | null): (number | null)[] | null {
  return c && [null];
}
function andNested(c: Other | null): { inner: Pair; list: (string | null)[] } | null {
  return c && { inner: { a: null, b: null }, list: [null] };
}
function andOptional(c: Other | null): { a?: string; b: number } | null {
  return c && { b: 1 };
}
function andBool(flag: boolean): Pair | false {
  return flag && { a: null, b: null };
}
function andNumber(n: number): Pair | 0 {
  return n && { a: null, b: null };
}
function andString(s: string): Pair | "" {
  return s && { a: null, b: null };
}
// The left operand is always an object: the pair is the literal.
function andObject(c: Other): Pair {
  return c && { a: null, b: null };
}
// The result keeps the literal's identity: a write through one name is read
// through the other.
function andIdentity(c: Other | null): string {
  const r: Cell | null = c && { v: null, w: null };
  const again = r;
  if (r !== null) r.v = "written";
  return again === null ? "null" : `${again.v}/${again.w}`;
}

function orOther(c: Other | null): Other | Pair {
  return c || { a: null, b: null };
}
function orArray(c: Other | null): Other | (string | null)[] {
  return c || [null, null];
}
function orSame(c: Pair | null): Pair {
  return c || { a: null, b: null };
}
// The left value is the answer itself, not a copy.
function orIdentity(c: Other | null): string {
  const r: Other | Pair = c || { a: null, b: null };
  if (c !== null) c.name = "written";
  return JSON.stringify(r);
}
function nullishOther(c: Other | null): Other | Pair {
  return c ?? { a: null, b: null };
}
function nullishArray(c: Other | undefined): Other | (string | null)[] {
  return c ?? [null];
}
function nullishSame(c: Pair | null): Pair {
  return c ?? { a: null, b: null };
}
function nullishIdentity(c: Other | null): string {
  const r: Other | Pair = c ?? { a: null, b: null };
  if (c !== null) c.name = "written again";
  return JSON.stringify(r);
}
function ternary(c: Other | null): Pair | null {
  return c ? { a: null, b: null } : null;
}
function ternaryOther(c: Other | null): Other | Pair {
  return c ? c : { a: null, b: null };
}

function show(name: string, f: () => unknown): void {
  try {
    console.log(name, JSON.stringify(f()));
  } catch (e) {
    console.log(name, "threw", (e as Error).message);
  }
}

for (const n of [-5, -1, 0, 3]) {
  show("guard " + n, () => guard(n));
  show("guardTwo " + n, () => guardTwo(n));
}
for (const n of [-1, 0, 3]) {
  const c = mk(n);
  const pair: Pair | null = n < 0 ? null : { a: "p" + n, b: null };
  show("andNull " + n, () => andNull(c));
  show("andStr " + n, () => andStr(c));
  show("andMixed " + n, () => andMixed(c));
  show("andSame " + n, () => andSame(c, n > 1 ? "s" : null));
  show("andParen " + n, () => andParen(c));
  show("andChain " + n, () => [andChain(c, c), andChain(c, null), andChain(null, c)]);
  show("andOr " + n, () => [andOr(c, null), andOr(c, pair)]);
  show("andDeclared " + n, () => andDeclared(c));
  show("andArgument " + n, () => andArgument(c));
  show("andArray " + n, () => andArray(c));
  show("andNumberArray " + n, () => andNumberArray(c));
  show("andNested " + n, () => andNested(c));
  show("andOptional " + n, () => andOptional(c));
  show("andBool " + n, () => andBool(n > 0));
  show("andNumber " + n, () => andNumber(n + 1));
  show("andString " + n, () => andString(n > 0 ? "s" : ""));
  show("andObject " + n, () => andObject({ name: "o" + n }));
  show("andIdentity " + n, () => andIdentity(c));
  show("orOther " + n, () => orOther(c));
  show("orArray " + n, () => orArray(c));
  show("orSame " + n, () => orSame(pair));
  show("orIdentity " + n, () => orIdentity(c));
  show("nullishOther " + n, () => nullishOther(c));
  show("nullishArray " + n, () => nullishArray(c ?? undefined));
  show("nullishSame " + n, () => nullishSame(pair));
  show("nullishIdentity " + n, () => nullishIdentity(c));
  show("ternary " + n, () => ternary(c));
  show("ternaryOther " + n, () => ternaryOther(c));
}
