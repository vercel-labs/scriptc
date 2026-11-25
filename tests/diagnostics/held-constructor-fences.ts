// Uses of a held primitive constructor that have no lowering, each refused
// by name: its prototype, a collection keyed by a union of several
// constructor types, and a store
// under a function type with no parameter in a program that hands a
// function of that type to a caller that passes arguments (the constructor
// would be answered as a call with none).
type Ctor = typeof String | typeof Number;

const table = { text: String, amount: Number };
const wrapped = new table.text("a");
const proto = table.amount.prototype;

function build(type: Ctor): unknown {
  return new type("1");
}

const labels = new Map<Ctor, string>();
labels.set(String, "text");
const none: () => unknown = table.text;
console.log(wrapped, proto, build(Number), labels.size, none(), ["a", "b"].map(none));
