// A map declared as Record<string, PropertyDescriptor> and filled in a loop.
function msg(e: unknown): string { return e instanceof TypeError ? "TypeError: " + e.message : e instanceof Error ? "Error: " + e.message : String(e); }
function desc(o: object, k: string | symbol): string { const d = Object.getOwnPropertyDescriptor(o, k); return d === undefined ? "none" : [d.writable, d.enumerable, d.configurable, typeof d.get, typeof d.set, "value" in d ? String(d.value) : "-"].join("/"); }

const o: any = {};
const map: Record<string, PropertyDescriptor> = {};
for (const k of ["x", "y"]) map[k] = { value: k.toUpperCase(), enumerable: true };
try {
  Object.defineProperties(o, map);
  console.log(o.x, o.y, JSON.stringify(o));
} catch (e) { console.log("failed:", msg(e)); }

export {};
