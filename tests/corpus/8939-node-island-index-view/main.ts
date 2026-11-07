// @requires-libnode
// A program type with an index signature that receives an island object is
// a live view of that object, and a key the object does not have reads
// undefined through it: TypeScript types `view[key]` as the value type
// whether or not the key exists. The same holds for the program's own
// values of the type, which share the view.
import { keptKeys, labels, lookup, setKept } from "table-pkg";

const view: Record<string, number> = lookup();
const missing = "nope";

// Comparisons with undefined and null.
console.log("strict:", view.a === undefined, view.nope === undefined, view[missing] === undefined, view["zz"] !== undefined);
console.log("loose:", view[missing] == null, view.a == null, view[missing] != null);
if (view[missing] === undefined) console.log("absent");
else console.log("present");
if (view[missing]) console.log("truthy");
else console.log("falsy");

// in, Object.hasOwn, ??, typeof, optional chains.
console.log("in:", "a" in view, missing in view, "nope" in view);
console.log("hasOwn:", Object.hasOwn(view, "a"), Object.hasOwn(view, missing));
console.log("nullish:", view[missing] ?? "default", view.a ?? "default", view.nope ?? -1);
console.log("typeof:", typeof view[missing], typeof view.a, typeof view.nope);
console.log("chain:", view[missing]?.toFixed(1), view.a?.toFixed(1));

// Destructuring, with and without defaults.
const { a = 7, nope = 8 } = view;
const { zz } = view;
console.log("destructured:", a, nope, zz === undefined, zz);

// Bindings.
const got = view[missing];
let later: number | undefined = view[missing];
console.log("bound:", got === undefined, got, later === undefined, later, got?.toFixed(1));

// Through a parameter, a class field and a member of a program object.
function read(table: Record<string, number>, key: string): string {
  const value = table[key];
  return value === undefined ? "missing" : "has " + value;
}
class Holder {
  table: Record<string, number> = lookup();
  get(key: string): string {
    return this.table[key] === undefined ? "missing" : "has";
  }
}
const holder = new Holder();
const boxed: { table: Record<string, number> } = { table: lookup() };
console.log("flows:", read(view, "a"), read(view, "q"), read(lookup(), "a"), read(lookup(), "q"));
console.log("members:", holder.get("a"), holder.get("zz"), boxed.table.zz === undefined, boxed.table.a === undefined);

// The island's later keys show through the view, and the view's writes
// reach the island.
const live: Record<string, number> = lookup();
setKept("late", 5);
console.log("island wrote:", live[missing] === undefined, live.late, live["late"] === undefined);
live.mine = 4;
delete live.a;
console.log("program wrote:", live.mine, live.a === undefined, "a" in live, Object.keys(live).join(","), keptKeys());
let total = 0;
for (const key of ["mine", "late", "gone"]) {
  const value = live[key];
  if (value !== undefined) total += value;
}
console.log("summed:", total);

// A string-valued signature.
const names: Record<string, string> = labels();
console.log("strings:", names[missing] === undefined, names.a, names[missing] ?? "default", names.a?.length, names[missing]?.length);

// The program's own values of the same types.
const own: Record<string, number> = { a: 1 };
const { b = 2, c } = own;
console.log("native:", read(own, "a"), read(own, "q"), own.q === undefined, own[missing] ?? "default", missing in own, Object.hasOwn(own, missing), b, c);
