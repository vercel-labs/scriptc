// util.MIMEType and util.MIMEParams: parsing, serialization, setters,
// parameter maps, iteration, errors, inspect, JSON and %s formatting.
const util = require("util");
const { MIMEType, MIMEParams, inspect, format } = util;
const show = (label, run) => {
  try { console.log(label, run()); } catch (e) { console.log(label, e.name, e.code, e.message); }
};
const inputs = [
  "text/javascript", "  TEXT/HTML ; Charset=UTF-8 ", "application/json;a=1;b=2;a=3", "text/plain;x", "text/plain;x=",
  'text/plain;q="a\\"b\\\\c";r="unterminated', 'text/plain;q="ends with \\', "text/plain;;;k=v;;", "text/plain; k = v",
  "text/plain;k=\"\"", "text/plain;é=1;v=é", "text/plain;k=vĀ", "image/svg+xml;charset=utf-8",
  "text", "text/", "/plain", "te xt/plain", "text/pla in", "té/x", "", " \t\r\n",
];
for (const input of inputs) {
  show(JSON.stringify(input), () => {
    const m = new MIMEType(input);
    return [m.type, m.subtype, m.essence, String(m), m.params.toString(), [...m.params]];
  });
}
show("parse ok", () => String(MIMEType.parse("Text/Plain;A=B")));
show("parse bad", () => MIMEType.parse("nope"));
show("illegal", () => new MIMEType("text/plain", 1));
show("null second", () => String(new MIMEType("text/plain", null)));
show("object input", () => String(new MIMEType({ toString: () => "a/b;c=d" })));
const m = new MIMEType("text/plain;charset=ascii");
m.type = "Application"; m.subtype = "JSON";
show("setters", () => String(m));
show("bad type", () => { m.type = "a b"; });
show("bad subtype", () => { m.subtype = ""; });
const p = m.params;
show("same params", () => p === m.params);
p.set("Charset", "utf-8"); p.set("q", "1 2"); p.set("empty", "");
show("params", () => [String(m), p.get("CHARSET"), p.get("none"), p.has("q"), p.toJSON()]);
show("bad name", () => p.set("a b", "x"));
show("bad value", () => p.set("ok", "Ā"));
p.delete("q");
show("after delete", () => [...p.keys()].join(","));
show("entries", () => [...p.entries()]);
show("values", () => [...p.values()]);
const fresh = new MIMEParams();
fresh.set("b", "2"); fresh.set("a", "1"); fresh.set("b", "3");
show("fresh", () => [String(fresh), [...fresh]]);
show("json", () => JSON.stringify({ m, p: fresh }));
show("instanceof", () => [m instanceof MIMEType, p instanceof MIMEParams, p instanceof MIMEType, {} instanceof MIMEType]);
console.log(m, p);
console.log(inspect({ nested: { m } }, { depth: 0 }));
const live = new MIMEParams();
live.set("a", "1"); live.set("b", "2"); live.set("c", "3");
const seen = [];
for (const [k] of live) { seen.push(k); if (k === "a") { live.delete("b"); live.set("d", "4"); } }
console.log(seen, `${m}`);

{
  show("number input", () => new MIMEType(5));
  show("undefined input", () => new MIMEType());
  const m = new MIMEType("a/b");
  const p = m.params;
  p.set(1, 2); p.set("semi", "x;y"); p.set("quote", 'say "hi"'); p.set("back", "a\\b"); p.set("space", "a b");
  show("quoted out", () => p.toString());
  show("get coerced", () => [p.get(1), p.has(1), p.get(), p.has()]);
  p.delete(1);
  show("deleted", () => [...p.keys()]);
  show("typeof", () => [typeof m, typeof p, typeof MIMEType]);
  show("keys", () => [Object.keys(m), Object.keys(p), m.foo, p.size]);
  show("upper set", () => { m.type = "TEXT"; m.subtype = "X-Thing+JSON"; return m.essence; });
  show("empty type", () => { m.type = ""; });
  show("type with slash", () => { m.type = "a/b"; });
  show("set name empty", () => p.set("", "v"));
  show("format", () => format("%s|%j|%o", m, m, p));
  show("inspect arr", () => inspect([m, p, { m }]));
  show("concat", () => "x" + m + p);
  show("parse throws?", () => [MIMEType.parse("a/b;c=\"d"), MIMEType.parse("")]);
  show("parse coerces", () => String(MIMEType.parse({ toString() { return "x/y;z=1"; } })));
  show("params iter", () => { const it = p[Symbol.iterator](); return [it.next(), it.next().value]; });
  show("entries next", () => { const it = p.entries(); return it.next(); });
  const bare = new MIMEType("a/b");
  console.log(Object.keys(bare), bare.foo, bare.params.size);
  console.log(format("%s|%s", bare, bare.params), "%s", new MIMEType("c/d;e=f"));
  // Every argument evaluates before the constructor or parse runs.
  const order = [];
  const note = (label) => { order.push(label); return label; };
  const coerced = { toString() { order.push("coerce"); return "a/b"; } };
  show("surplus, then coercion", () => { new MIMEType(coerced, undefined, note("third")); return order.splice(0).join(","); });
  show("surplus, then parse error", () => { try { new MIMEType("bad", undefined, note("x")); } catch (e) { order.push(e.code); } return order.splice(0).join(","); });
  show("parse surplus", () => { MIMEType.parse(coerced, note("second")); return order.splice(0).join(","); });
  show("params surplus", () => { new MIMEParams(note("p")); return order.splice(0).join(","); });
}
