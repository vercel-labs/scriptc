// Object.prototype's methods on typed records keep JavaScript's evaluation
// order and key conversions.

// A function-table key that reassigns the receiver reads the table
// evaluated before the key.
let table: Record<string, () => string> = { a: () => "first" };
const other: Record<string, () => string> = { a: () => "second" };
function key(): string {
  table = other;
  return "a";
}
console.log(String(table[key()]()));

// hasOwnProperty and propertyIsEnumerable with a symbol key on a record of
// functions test the symbol key.
const fns: Record<string, (n: number) => number> = { double: (n) => n * 2 };
const sym = Symbol("s");
console.log(fns.hasOwnProperty(sym as unknown as string), fns.propertyIsEnumerable(sym as unknown as string));

// A call by name reads the method before its arguments run: an argument
// that adds, replaces or deletes the own method does not change the callee.
type Has = Record<string, (key: string) => boolean>;
function add(r: Has): string {
  r.hasOwnProperty = () => true;
  return "zzz";
}
function swap(r: Has): string {
  r.hasOwnProperty = (key) => key === "b";
  return "a";
}
function drop(r: Has): string {
  delete r["hasOwnProperty"];
  return "zzz";
}
const added: Has = {};
console.log(added.hasOwnProperty(add(added)), added.hasOwnProperty("zzz"));
const swapped: Has = { hasOwnProperty: (key) => key === "a" };
console.log(swapped.hasOwnProperty(swap(swapped)), swapped.hasOwnProperty("a"));
const removed: Has = { hasOwnProperty: () => true };
console.log(removed.hasOwnProperty(drop(removed)), removed.hasOwnProperty("zzz"));
