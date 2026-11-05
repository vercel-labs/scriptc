// Reflect.has over the checked-dynamic view, and the Object reflection
// operations over records, arrays and class instances (own fields and
// elements in property order). Reflect.has is [[HasProperty]], so inherited
// names (Array.prototype's, Object.prototype's, a class's methods) answer
// true; a primitive target is Node's TypeError and stays a lowerer fence
// (SC2020) rather than a silent `false`.
class Point {
  x = 1;
  y = 2;
  sum(): number {
    return this.x + this.y;
  }
}
const record = { a: 1, b: "two" };
const list = [10, 20];
const point = new Point();
console.log(Reflect.has(record, "a"), Reflect.has(record, "z"));
console.log(Reflect.has(list, "0"), Reflect.has(list, "length"), Reflect.has(list, "9"));
console.log(Reflect.has(point, "x"), Reflect.has(point, "sum"));
const key = "b";
console.log(Reflect.has(record, key), Reflect.has(record, key.toUpperCase()));
console.log(Reflect.has(record, "toString"), Reflect.has(record, "constructor"));
console.log(Object.getOwnPropertyNames(record).join(","));
console.log(Object.getOwnPropertyNames(point).join(","));
console.log(Object.getOwnPropertyNames(list).length);
const descriptors = Object.getOwnPropertyDescriptors(record);
console.log(Object.keys(descriptors).join(","));
console.log(Object.getOwnPropertySymbols(record).length);
// A primitive target held as any, unknown or a union throws Node's
// TypeError; its key is evaluated first.
function hasThrough(target: unknown, name: string): string {
  try {
    return String(Reflect.has(target as any, name));
  } catch (e) {
    return `${(e as Error).name}: ${(e as Error).message}`;
  }
}
const loose: any = "text";
const either: string | { a: number } = Math.random() > 2 ? { a: 1 } : "text";
console.log(hasThrough(loose, "length"), hasThrough(42, "x"), hasThrough(undefined, "x"));
console.log(hasThrough({ a: 1 }, "a"), hasThrough(either, "a"));
let keys = 0;
try {
  Reflect.has(loose, String(++keys));
} catch (e) {
  console.log((e as Error).name, keys);
}
