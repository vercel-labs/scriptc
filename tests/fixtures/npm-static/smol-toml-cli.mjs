// The published smol-toml package compiled as static modules: parsing every
// value kind, the TomlDate subclass of Date, stringify and TomlError.
import { parse, stringify, TomlDate, TomlError } from "smol-toml";
const text = `
# a document
title = "TOML \\"example\\""
int = +99
neg = -17
hex = 0xDEADBEEF
oct = 0o755
bin = 0b1101
under = 1_000_000
float = 6.626e-34
inf = inf
nan = nan
bool = true
odt1 = 1979-05-27T07:32:00Z
odt2 = 1979-05-27T00:32:00-07:00
odt3 = 1979-05-27T00:32:00.999999-07:00
ldt = 1979-05-27T07:32:00
ld = 1979-05-27
lt = 07:32:00.123
space = 1979-05-27 07:32:00Z
literal = 'C:\\Users\\nodejs\\templates'
multi = """
Roses are red
Violets are blue"""
lmulti = '''
The first newline is
trimmed in raw strings.'''

[owner]
name = "Tom"
"quoted key" = 1
dotted.inner.key = "x"

[database]
ports = [ 8000, 8001, 8002 ]
data = [ ["delta", "phi"], [3.14] ]
temp_targets = { cpu = 79.5, case = 72.0 }

[[products]]
name = "Hammer"
sku = 738594937

[[products]]

[[products]]
name = "Nail"
color = "gray"
`;
const doc = parse(text);
console.log(JSON.stringify(doc, null, 1));
for (const key of ["odt1", "odt2", "odt3", "ldt", "ld", "lt", "space"]) {
  const d = doc[key];
  console.log(key, d instanceof Date, d instanceof TomlDate, d.isDateTime(), d.isLocal(), d.isDate(), d.isTime(), d.isValid(), d.toISOString(), Number.isNaN(d.getTime()) ? "NaN" : d.getTime());
}
console.log(Number.isNaN(doc.nan), doc.inf, typeof doc.hex, doc.under);
console.log(stringify(doc));
console.log(stringify({ a: new Date(0), b: TomlDate.wrapAsLocalDate(new Date(86400000)), c: new TomlDate("10:20:30"), n: [1, [2, 3]], t: { u: { v: "w" } }, s: "quote\" and \\ backslash", f: 1.5, i: 2, big: 2n ** 40n }));
const d = new TomlDate("2020-02-29T12:00:00+01:00");
console.log(d.toISOString(), JSON.stringify({ d }), String(d.getUTCHours()), d.valueOf());
const bad = new TomlDate("not a date");
console.log(bad.isValid(), Number.isNaN(bad.getTime()));
for (const src of ["a = ", "a = 1\na = 2", "[t]\n[t]", "x = [1,", "k = 1979-13-01", "s = \"unterminated", "= 1", "a = 25:00:00"]) {
  try { parse(src); console.log("parsed", JSON.stringify(src)); }
  catch (e) { console.log(e instanceof TomlError, e instanceof Error, e.name, e.line, e.column, e.message.split("\n")[0]); }
}
