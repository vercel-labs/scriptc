// A member call passes the object the member was read from as `this`:
// `holder.f()`, `holder["f"]()`, `holder.f?.()`, `holder?.f()`,
// `holder.f!()`, a keyed call on a dictionary and an element call on an
// array or a tuple. A function that reads the receiver of its call (one
// with a `this` parameter, or an object-literal method read off its object)
// sees that object; a call of the value by itself passes none.
type Probe = (label: string) => void;

function describe(this: unknown, label: string): void {
  const self = this as { tag?: unknown } | undefined;
  console.log(label, this === undefined, typeof this, self === undefined ? "none" : self.tag);
}
const describeExpr = function (this: unknown, label: string): void {
  console.log(label, this === undefined, typeof this);
};
const source = {
  tag: "source",
  probe(label: string): void {
    console.log(label, this === undefined, typeof this, this === undefined ? "none" : this.tag);
  },
};

// A record, by its literal's type and by an interface.
const holder = { tag: "holder", f: describe, g: describeExpr, h: source.probe };
holder.f("record field");
holder.g("record field, expression");
holder.h("record field, borrowed method");
holder["f"]("record element");
(holder.f)("record parenthesized");

interface Holder {
  tag: string;
  f: Probe;
  g?: Probe;
  m(label: string): void;
}
const typed: Holder = { tag: "typed", f: describe, g: describe, m: describe };
typed.f("interface property");
typed.m("interface method");
typed.g?.("optional call");
typed.g!("non-null call");
const maybe: Holder | undefined = process.argv.length > 100 ? undefined : typed;
maybe?.f("optional holder");

function run(target: Holder): void {
  target.f("parameter");
}
run({ tag: "argument", f: describe, m: describe });

const outer = { tag: "outer", inner: { tag: "inner", f: describe } };
outer.inner.f("nested");

// A union of records.
interface Left {
  kind: "left";
  tag: string;
  f: Probe;
}
interface Right {
  kind: "right";
  tag: string;
  f: Probe;
}
const sides: (Left | Right)[] = [
  { kind: "left", tag: "left", f: describe },
  { kind: "right", tag: "right", f: describe },
];
for (const side of sides) side.f(`union ${side.kind}`);

// A dictionary, an array and a tuple.
const handlers: Record<string, Probe> = { first: describe, second: describeExpr };
const name = process.argv.length > 100 ? "second" : "first";
handlers[name]!("dictionary key");
handlers.second!("dictionary member");
console.log(Object.keys(handlers).join());

function size(this: unknown[]): number {
  return this.length;
}
const sizes: (() => number)[] = [size as () => number, size as () => number];
console.log("array element", sizes[0]!(), sizes[sizes.length - 1]!());
const pair: [string, Probe] = ["pair", describeExpr];
pair[1]("tuple element");

// The value by itself: no receiver.
const detached = holder.f;
detached("detached");
const { f: destructured } = holder;
destructured("destructured");
for (const each of [holder.f]) each("for-of");
const table = new Map<string, Probe>([["f", describe]]);
table.get("f")!("map value");
(0, holder.f)("comma");

// Functions that never read `this` are called as before.
const plain = { tag: "plain", f: (label: string): void => console.log(label, "arrow") };
plain.f("arrow member");
const lookup: Record<string, (x: number) => number> = { double: (x) => x * 2 };
console.log(lookup["double"]!(21));
