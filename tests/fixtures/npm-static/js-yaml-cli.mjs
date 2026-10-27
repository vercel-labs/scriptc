// The published js-yaml package compiled as static modules: loading, dumping,
// schemas, custom types and the YAMLException errors it throws.
import yaml from "js-yaml";
const text = `
# config
name: demo
version: 1.2
count: 0x1F
octal: 0o17
neg: -12_000
flt: 6.02e+23
inf: .inf
nan: .NaN
on: yes
off: false
nil: ~
date: 2001-12-14
stamp: 2001-12-14t21:59:43.10-05:00
str: "quoted \\u263A \\t tab"
single: 'it''s'
multi: |
  line one
  line two
folded: >-
  folded
  text
base: &base { a: 1, b: [x, y] }
derived:
  <<: *base
  c: 3
list:
  - one
  - { k: v }
  - [1, 2, 3]
  - !!str 123
set: !!set { a, b }
omap: !!omap [ { x: 1 }, { y: 2 } ]
binary: !!binary aGVsbG8=
`;
const doc = yaml.load(text);
console.log(JSON.stringify(doc, (k, v) => (v instanceof Uint8Array ? Array.from(v) : v)));
console.log(doc.stamp instanceof Date, doc.stamp.toISOString(), doc.date.toISOString(), Object.is(doc.nan, NaN) || Number.isNaN(doc.nan));
const docs = yaml.loadAll("---\na: 1\n---\nb: 2\n...\n");
console.log(JSON.stringify(docs));
const items = [];
yaml.loadAll("--- 1\n--- two\n", (d) => items.push(d));
console.log(items);
console.log(yaml.dump(doc, { sortKeys: true, lineWidth: 40, skipInvalid: true }));
console.log(yaml.dump({ a: "multi\nline\n", b: "  lead", c: "yes", d: "123", e: null, f: [], g: {}, h: "x: y", i: -0, j: 1e21 }, { indent: 4 }));
console.log(yaml.dump([{ deep: { er: [1, { z: true }] } }], { flowLevel: 2 }));
console.log(yaml.dump({ s: "a'b\"c", u: "é☺", long: "word ".repeat(30).trim() }, { quotingType: '"', forceQuotes: true }));
for (const bad of ["a: [1", "a: b: c", "- a\nb: 1", "key: 'open", "a: !!int x", "? a\n? a\n", "&x a: *y"]) {
  try { yaml.load(bad); console.log("no error", bad); }
  catch (e) { console.log(e.name, "|", e.reason, "|", e.mark && e.mark.line, e.mark && e.mark.column, "|", e.message.split("\n")[0]); console.log(e.toString(true)); console.log(String(e).split("\n").length); }
}
try { yaml.load("a: 1\na: 2"); } catch (e) { console.log(e instanceof yaml.YAMLException, e instanceof Error, e.message); }
console.log(JSON.stringify(yaml.load("a: 1\na: 2", { json: true })));
console.log(JSON.stringify(yaml.load("x: 1", { schema: yaml.JSON_SCHEMA })), JSON.stringify(yaml.load("x: yes", { schema: yaml.FAILSAFE_SCHEMA })), JSON.stringify(yaml.load("x: yes", { schema: yaml.CORE_SCHEMA })));
const Point = new yaml.Type("!point", { kind: "sequence", construct: (d) => ({ x: d[0], y: d[1] }), instanceOf: Object, represent: (p) => [p.x, p.y] });
const schema = yaml.DEFAULT_SCHEMA.extend([Point]);
console.log(JSON.stringify(yaml.load("p: !point [3, 4]", { schema })));
try { yaml.dump({ f() {} }); } catch (e) { console.log(e.name, e.message); }
console.log(yaml.dump({ f() {}, u: undefined, k: 1 }, { skipInvalid: true }));
