// Redefining: data to accessor and back, and a non-configurable property.
function msg(e: unknown): string { return e instanceof TypeError ? "TypeError: " + e.message : e instanceof Error ? "Error: " + e.message : String(e); }
function desc(o: object, k: string | symbol): string { const d = Object.getOwnPropertyDescriptor(o, k); return d === undefined ? "none" : [d.writable, d.enumerable, d.configurable, typeof d.get, typeof d.set, "value" in d ? String(d.value) : "-"].join("/"); }

const o: any = { a: 1 };
try {
  Object.defineProperties(o, { a: { get() { return 2; } } });
  console.log(o.a, desc(o, "a"));
  Object.defineProperties(o, { a: { value: 3 } });
  console.log(o.a, desc(o, "a"));
  Object.defineProperties(o, { fixed: { value: 1 } });
  try { Object.defineProperties(o, { fixed: { value: 2 } }); console.log("no throw"); } catch (e) { console.log(msg(e)); }
  try { Object.defineProperties(o, { fixed: { get() { return 1; } } }); console.log("no throw"); } catch (e) { console.log(msg(e)); }
  console.log(Object.defineProperties(o, { fixed: { value: 1, writable: false } }) === o);
} catch (e) { console.log("failed:", msg(e)); }

export {};
