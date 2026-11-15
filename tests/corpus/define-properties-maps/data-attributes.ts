// Data descriptors: every attribute combination, read back.
function msg(e: unknown): string { return e instanceof TypeError ? "TypeError: " + e.message : e instanceof Error ? "Error: " + e.message : String(e); }
function desc(o: object, k: string | symbol): string { const d = Object.getOwnPropertyDescriptor(o, k); return d === undefined ? "none" : [d.writable, d.enumerable, d.configurable, typeof d.get, typeof d.set, "value" in d ? String(d.value) : "-"].join("/"); }

const o: any = {};
try {
  Object.defineProperties(o, {
    bare: { value: 1 },
    w: { value: 2, writable: true },
    e: { value: 3, enumerable: true },
    c: { value: 4, configurable: true },
    all: { value: 5, writable: true, enumerable: true, configurable: true },
    none: {},
  });
  for (const k of ["bare", "w", "e", "c", "all", "none", "missing"]) console.log(k, desc(o, k));
  o.w = 20; o.all = 50;
  console.log(o.bare, o.w, o.all, Object.keys(o).join(","), JSON.stringify(o));
} catch (e) { console.log("failed:", msg(e)); }

export {};
