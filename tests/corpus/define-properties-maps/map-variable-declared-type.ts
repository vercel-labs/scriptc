// A map declared as PropertyDescriptorMap and filled key by key.
function msg(e: unknown): string { return e instanceof TypeError ? "TypeError: " + e.message : e instanceof Error ? "Error: " + e.message : String(e); }
function desc(o: object, k: string | symbol): string { const d = Object.getOwnPropertyDescriptor(o, k); return d === undefined ? "none" : [d.writable, d.enumerable, d.configurable, typeof d.get, typeof d.set, "value" in d ? String(d.value) : "-"].join("/"); }

const o: any = {};
const map: PropertyDescriptorMap = { a: { value: 1, enumerable: true } };
map.b = { value: 2, enumerable: true };
map["c"] = { get: () => 3 };
try {
  Object.defineProperties(o, map);
  console.log(o.a, o.b, o.c, Object.keys(o).join(","));
} catch (e) { console.log("failed:", msg(e)); }

export {};
