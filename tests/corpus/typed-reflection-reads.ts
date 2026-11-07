// Read-only reflection over values whose static type is a record, an array, a
// class instance or a function: own-property descriptors, own-property names
// and symbols, and the integrity probes. Descriptors report the declared
// field or element with JS's writable/enumerable/configurable bits, and an
// added key shows up as an own property.
type Point = { x: number; y: number; label?: string };

function show(label: string, descriptor: PropertyDescriptor | undefined): void {
  console.log(label, JSON.stringify(descriptor));
}

const point: Point = { x: 1, y: 2 };
show("field", Object.getOwnPropertyDescriptor(point, "x"));
show("absent", Object.getOwnPropertyDescriptor(point, "label"));
show("missing", Object.getOwnPropertyDescriptor(point, "nope"));
console.log("names", Object.getOwnPropertyNames(point).join(","));
console.log("symbols", Object.getOwnPropertySymbols(point).length);

const array: string[] = ["a", "b"];
show("element", Object.getOwnPropertyDescriptor(array, "0"));
show("length", Object.getOwnPropertyDescriptor(array, "length"));
console.log("array names", Object.getOwnPropertyNames(array).join(","));

class Account {
  owner: string;
  balance: number;
  constructor(owner: string, balance: number) {
    this.owner = owner;
    this.balance = balance;
  }
}
const account = new Account("ann", 10);
show("instance field", Object.getOwnPropertyDescriptor(account, "balance"));
console.log("instance names", Object.getOwnPropertyNames(account as object).join(","));

const bytes = new Uint8Array(2);
console.log("bytes names", Object.getOwnPropertyNames(bytes).join(","));

function callback(): number {
  return 1;
}
show("function name", Object.getOwnPropertyDescriptor(callback, "name"));
console.log("function names", Object.getOwnPropertyNames(callback).join(","));

// Integrity probes over typed values.
const record: { a: number } = { a: 1 };
const list: number[] = [1];
const loose: unknown = { a: 1, b: 2 };
console.log(
  "integrity",
  Object.isSealed(record),
  Object.isFrozen(record),
  Object.isExtensible(record),
  Object.isSealed(list),
  Object.isExtensible(list),
  Object.isExtensible(loose as object),
);
