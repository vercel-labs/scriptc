// Uses of a held primitive constructor that have no lowering, each refused
// by name: its prototype, and a collection keyed by a union of several
// constructor types.
type Ctor = typeof String | typeof Number;

const table = { text: String, amount: Number };
const wrapped = new table.text("a");
const proto = table.amount.prototype;

function build(type: Ctor): unknown {
  return new type("1");
}

const labels = new Map<Ctor, string>();
labels.set(String, "text");
console.log(wrapped, proto, build(Number), labels.size);
