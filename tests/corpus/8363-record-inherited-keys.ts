// Object.prototype's own-key tests on records of functions convert their
// argument to a property key as Node does: an array joins its elements, and
// a record or class instance with its own toString calls it. A keyed read
// that falls back to an inherited method keeps the bound method alive
// through the checked projection that lends it.
type ListTest = (key: string[]) => unknown;
const lists: Record<string, ListTest> = { a: () => "a", "a,b": () => "a,b" };
console.log(
  lists["hasOwnProperty"](["a"]),
  lists["hasOwnProperty"](["a", "b"]),
  lists["propertyIsEnumerable"](["b"]),
);

type Named = { toString(): string };
type NamedTest = (key: Named) => unknown;
const named: Record<string, NamedTest> = { echo: () => "echo" };
let calls = 0;
const echoKey: Named = {
  toString() {
    calls++;
    return "echo";
  },
};
console.log(
  named["hasOwnProperty"](echoKey),
  named["propertyIsEnumerable"]({ toString: () => "nope" }),
  calls,
);

class Label {
  readonly text: string;
  constructor(text: string) {
    this.text = text;
  }
  toString(): string {
    return this.text;
  }
}
type LabelTest = (key: Label) => unknown;
const labels: Record<string, LabelTest> = { x: () => "x" };
console.log(labels["hasOwnProperty"](new Label("x")), labels["hasOwnProperty"](new Label("y")));

type Op = (x: string) => unknown;
const table: Record<string, Op> = { echo: (x) => x };
// `table[name]!` is a checked projection: its successful arm lends the
// read, whose miss binds the inherited method to the record.
function run(name: string): unknown {
  return table[name]!("echo");
}
for (const name of ["echo", "hasOwnProperty", "toString", "propertyIsEnumerable"])
  console.log(name, String(run(name)));
