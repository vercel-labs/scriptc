// An accessor with a value or `writable`: a TypeError before any property is defined.
function msg(e: unknown): string { return e instanceof TypeError ? "TypeError: " + e.message : e instanceof Error ? "Error: " + e.message : String(e); }
function desc(o: object, k: string | symbol): string { const d = Object.getOwnPropertyDescriptor(o, k); return d === undefined ? "none" : [d.writable, d.enumerable, d.configurable, typeof d.get, typeof d.set, "value" in d ? String(d.value) : "-"].join("/"); }

const o: any = {};
const getter: any = () => 1;
try {
  Object.defineProperties(o, { first: { value: 1, enumerable: true }, bad: { get: getter, value: 2 } });
  console.log("no throw");
} catch (e) { console.log("mixed:", e instanceof TypeError); }
console.log("defined before the error:", Object.keys(o).join(",") || "nothing");
try {
  Object.defineProperties(o, { first: { value: 1, enumerable: true }, bad: { set: getter, writable: true } });
  console.log("no throw");
} catch (e) { console.log("mixed writable:", e instanceof TypeError); }
console.log("defined before the error:", Object.keys(o).join(",") || "nothing");

export {};
