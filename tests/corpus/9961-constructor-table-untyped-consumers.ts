// A table of constructors handed to consumers that the typed tier has no
// lowering for when the value is a record of functions (printing, JSON,
// `in`, key listing, an `any` slot, bind): the program then holds its
// constructors untyped, and every line answers as under Node. The last loop
// is what such a table is for, and answers the same in either form.
import { strictEqual } from "node:assert";
import { format, inspect, isDeepStrictEqual } from "node:util";

type Reader = typeof String | typeof Number | typeof Boolean;
const shelf: Record<string, Reader> = { title: String, pages: Number, lent: Boolean };
const order: Reader[] = [Number, String, Boolean];
const byName = new Map<string, Reader>([
  ["title", String],
  ["pages", Number],
]);

console.log(shelf);
console.log(inspect(shelf), format("%O", shelf.title), format("%j", shelf), format("%d", shelf.pages));
console.log(JSON.stringify(shelf), JSON.stringify({ t: shelf, n: 1 }), JSON.stringify([shelf.title, 1]));
console.log(JSON.stringify(shelf.title), JSON.stringify(shelf, null, 2));
console.log(JSON.stringify(shelf, (_k: string, v: unknown) => (typeof v === "function" ? "fn" : v)));
console.log("name" in shelf.title, "zz" in shelf.title, Object.keys(shelf.title).length);
console.log(Object.hasOwn(shelf.title, "name"), shelf.title.hasOwnProperty("length"));
console.log(Object.prototype.toString.call(shelf.pages), shelf.pages.valueOf() === shelf.pages);
const loose: any = shelf;
console.log(typeof loose.title, loose.title === String, loose.pages("4"), Object.keys(loose).join(","));
const bound = shelf.pages.bind(null);
console.log(typeof bound, bound("4"));
console.log(shelf.title?.("42"), order.length, byName.size);
console.log(order);
console.log(byName);
strictEqual(shelf.title, String);
console.log(isDeepStrictEqual(shelf, shelf), typeof shelf, Array.isArray(order));
try {
  structuredClone(shelf);
  console.log("cloned");
} catch (err) {
  console.log(err instanceof Error ? err.name : "other");
}
for (const key of Object.keys(shelf)) {
  const read = shelf[key];
  console.log(key, read.name, read.length, read === Boolean, String(read("7")));
}
