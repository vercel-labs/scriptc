// A checked record keeps a declared key non-enumerable when the object it
// was converted from held the key that way. The record has no place for
// the attribute, so its kept-source view holds it: Object.keys, values,
// entries, for...in, JSON.stringify, console.log and untyped views leave
// the key out, while reads, writes, `in`, hasOwn and getOwnPropertyNames
// still see it, and its descriptor reports the attribute.

interface Schema {
  kind: string;
  type: string;
  note?: string;
}

function hide(target: any, key: string, value: unknown): void {
  Object.defineProperty(target, key, { enumerable: false, writable: true, configurable: true, value });
}

// `extra` adds a key the type does not declare, so the record keeps a view
// for two reasons at once.
function make(extra: boolean): Schema {
  const o: any = JSON.parse('{"type":"t"}');
  if (extra) o.description = "d";
  hide(o, "kind", "K");
  return o as Schema;
}

const s = make(false);
const x = make(true);

console.log("read", s.kind, s.type, x.kind, x.type);
console.log("keys", Object.keys(s).join(","), "|", Object.keys(x).join(","));
console.log("values", Object.values(s).join(","), "|", Object.values(x).join(","));
console.log("entries", JSON.stringify(Object.entries(s)), JSON.stringify(Object.entries(x)));
for (const k in s) console.log("for-in s", k);
for (const k in x) console.log("for-in x", k);
console.log("json", JSON.stringify(s), JSON.stringify(x));
console.log("json nested", JSON.stringify({ wrap: s, list: [x] }));
console.log(JSON.stringify(s, null, 2));
console.log("has", "kind" in s, Object.hasOwn(s, "kind"), "kind" in x, Object.hasOwn(x, "type"));
console.log("names", Object.getOwnPropertyNames(s).join(","), "|", Object.getOwnPropertyNames(x).join(","));
console.log(s);
console.log(x);
console.log([s]);

// A write through the type keeps the attribute.
s.kind = "K2";
x.kind = "K3";
console.log("written", s.kind, Object.keys(s).join(","), JSON.stringify(s));
console.log("written", x.kind, Object.keys(x).join(","), JSON.stringify(x));

// Untyped views of the same records.
const a: any = s;
const b: any = x;
console.log("view", Object.keys(a).join(","), JSON.stringify(a), a.kind);
console.log("view", JSON.stringify(Object.getOwnPropertyDescriptor(a, "kind")));
console.log("view", Object.keys(b).join(","), JSON.stringify(b), b.kind);
console.log("view", JSON.stringify(Object.getOwnPropertyDescriptor(b, "kind")));
console.log("view", JSON.stringify(Object.getOwnPropertyDescriptor(b, "type")));
a.kind = "W";
console.log("view write", s.kind, Object.keys(s).join(","), JSON.stringify(s));
console.log("view write", JSON.stringify(Object.getOwnPropertyDescriptor(a, "kind")));

// Back through a checked cast: the same record, the key still hidden.
const back = a as Schema;
console.log("back", back === s, Object.keys(back).join(","), JSON.stringify(back));

// A conversion to another record type keeps it hidden too.
const narrow: { type: string } = x;
console.log("narrow", Object.keys(narrow).join(","), JSON.stringify(narrow));
const other = b as { type: string; description: string };
console.log("other", Object.keys(other).join(","), JSON.stringify(other));

// Records inside records and arrays.
interface Outer {
  inner: Schema;
  list: Schema[];
}
const outer: Outer = { inner: s, list: [x, make(false)] };
console.log("outer", JSON.stringify(outer), Object.keys(outer.inner).join(","));
const untypedOuter: any = outer;
console.log("outer view", JSON.stringify(untypedOuter), Object.keys(untypedOuter.list[1]).join(","));
console.log("each", outer.list.map((v) => Object.keys(v).join("+")).join(" "));
console.log("from entries", JSON.stringify(Object.fromEntries(Object.entries(x))));

// Making the key enumerable again through the view is seen through the type.
Object.defineProperty(b, "kind", { enumerable: true });
console.log("shown", Object.keys(x).join(","), JSON.stringify(x));

// A hidden key the type does not declare stays hidden as well.
function makeUndeclared(): { type: string } {
  const o: any = JSON.parse('{"type":"t"}');
  hide(o, "secret", 1);
  return o as { type: string };
}
const u = makeUndeclared();
const uv: any = u;
console.log("undeclared", Object.keys(u).join(","), JSON.stringify(u), uv.secret, "secret" in u);
