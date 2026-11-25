// Getters on a map held in a variable: read again on each call.
function msg(e: unknown): string { return e instanceof TypeError ? "TypeError: " + e.message : e instanceof Error ? "Error: " + e.message : String(e); }
function desc(o: object, k: string | symbol): string { const d = Object.getOwnPropertyDescriptor(o, k); return d === undefined ? "none" : [d.writable, d.enumerable, d.configurable, typeof d.get, typeof d.set, "value" in d ? String(d.value) : "-"].join("/"); }

const log: string[] = [];
const o: any = {};
const map = {
  get z(): PropertyDescriptor { log.push("read z"); return { value: 1, enumerable: true }; },
  b: { value: 2, enumerable: true },
  get a(): PropertyDescriptor { log.push("read a"); return { value: 3, enumerable: true }; },
};
try {
  Object.defineProperties(o, map);
  console.log(o.z, o.b, o.a, Object.keys(o).join(","), log.join("|"));
  Object.defineProperties(o, map);
  console.log(log.join("|"));
} catch (e) { console.log("failed:", msg(e)); }

export {};
