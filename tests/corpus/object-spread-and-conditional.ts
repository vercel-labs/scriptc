// `...(cond && { k: v })` spreads nothing when cond is a falsy primitive
// (false, 0, ""), so it is the optional-field idiom `...(cond ? { k: v } : {})`:
// cond evaluates once, v only when taken. (Fields print one by one: the
// declared-shape property order of spread-built records is a documented
// limitation.)
type C = { name: string; name2: string; httpOnly?: boolean; maxAge?: number; path?: string; sameSite?: string };
function parse(attrs: Record<string, string | undefined>, flag: boolean): C {
  const httponly = attrs.httponly;
  const maxage = attrs["max-age"];
  const samesite = attrs.samesite;
  let calls = 0;
  const lower = (s: string): string => {
    calls++;
    return s.toLowerCase();
  };
  const c: C = {
    name: "a",
    ...(flag && { httpOnly: true }),
    ...(httponly && { path: httponly }),
    ...(typeof maxage === "string" && { maxAge: Number(maxage) }),
    name2: "/",
    ...(samesite && { sameSite: lower(samesite) }),
  };
  console.log("calls", calls);
  return c;
}
for (const [attrs, flag] of [
  [{}, false],
  [{ httponly: "yes", "max-age": "10", samesite: "Lax" }, true],
  [{ httponly: "", "max-age": "", samesite: "" }, true],
] as [Record<string, string | undefined>, boolean][]) {
  const c = parse(attrs, flag);
  console.log(c.name, c.name2, c.httpOnly, c.path, c.maxAge, c.sameSite, "httpOnly" in c, "path" in c);
}
const n: number = Number(process.argv.length > 99 ? "1" : "0");
const d: { v?: number; name: string } = { name: "n", ...(n && { v: n }) };
console.log(d.name, d.v, "v" in d);
