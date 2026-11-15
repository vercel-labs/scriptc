// Getters on the map: each is read once, in key order.
function msg(e: unknown): string { return e instanceof TypeError ? "TypeError: " + e.message : e instanceof Error ? "Error: " + e.message : String(e); }
function desc(o: object, k: string | symbol): string { const d = Object.getOwnPropertyDescriptor(o, k); return d === undefined ? "none" : [d.writable, d.enumerable, d.configurable, typeof d.get, typeof d.set, "value" in d ? String(d.value) : "-"].join("/"); }

const log: string[] = [];
const o: any = {};
try {
  Object.defineProperties(o, {
    get a() { log.push("read a"); return { value: 1, enumerable: true }; },
    b: { value: 2, enumerable: true },
    get c() { log.push("read c"); return { get() { return 3; }, enumerable: true }; },
  });
  console.log(o.a, o.b, o.c, Object.keys(o).join(","), log.join("|"));
} catch (e) { console.log("failed:", msg(e)); }

export {};
