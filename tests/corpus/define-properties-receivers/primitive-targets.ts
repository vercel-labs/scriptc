// Primitive receivers: the TypeError, with and without keys.
function msg(e: unknown): string { return e instanceof TypeError ? "TypeError: " + e.message : e instanceof Error ? "Error: " + e.message : String(e); }
function desc(o: object, k: string | symbol): string { const d = Object.getOwnPropertyDescriptor(o, k); return d === undefined ? "none" : [d.writable, d.enumerable, d.configurable, typeof d.get, typeof d.set, "value" in d ? String(d.value) : "-"].join("/"); }

const values: unknown[] = [1, "s", true, null, undefined, Symbol("q"), 10n];
for (const value of values) {
  try { Object.defineProperties(value as object, {}); console.log("no throw", typeof value); } catch (e) { console.log(typeof value, msg(e)); }
}
for (const value of values) {
  try { Object.defineProperties(value as object, { a: { value: 1 } }); console.log("no throw", typeof value); } catch (e) { console.log(typeof value, msg(e)); }
}

export {};
