// Copies and enumerations of records JavaScript builds follow the order
// JavaScript wrote, also when the TypeScript literals of the type write
// another order and spread their own type. Each case uses its own type.
import { install, installLabel } from "./lib.js";

interface Pair {
  a: number;
  b: number;
}

interface Row {
  x: number;
  y: number;
}

interface Options {
  visit: (row: Row) => void;
}

class Store {
  get(): Pair {
    return { b: 2, a: 1 };
  }
}

function showPair(label: string, value: Pair): void {
  const copy = { ...value };
  console.log(label, Object.keys(value).join(), JSON.stringify(copy), Object.keys(copy).join());
}

function showRow(label: string, value: Row): void {
  const copy = { ...value };
  console.log(label, Object.keys(value).join(), JSON.stringify(copy), Object.keys(copy).join());
}

// A replaceable method whose replacement returns a record JavaScript builds.
const store = new Store();
showPair("method", store.get());
showPair("self copy", { ...store.get(), b: 3 });
install(store, "get");
showPair("replaced", store.get());
const labels: { label(): string } = { label: () => "plain" };
installLabel(labels, "label");
console.log(labels.label());

// A JavaScript function, checked into a typed slot, calls a native callback
// it receives inside its options record with a record it builds.
const literal: Row = { y: 20, x: 10 };
showRow("literal", literal);
showRow("self copy", { ...literal, y: 21 });
const eachRow = (globalThis as typeof globalThis & { __eachRow: (options: Options) => void })
  .__eachRow;
eachRow({ visit: (row: Row) => showRow("checked function", row) });
