// Getters on a descriptor: read in ToPropertyDescriptor order; attribute values convert to booleans.
function msg(e: unknown): string { return e instanceof TypeError ? "TypeError: " + e.message : e instanceof Error ? "Error: " + e.message : String(e); }
function desc(o: object, k: string | symbol): string { const d = Object.getOwnPropertyDescriptor(o, k); return d === undefined ? "none" : [d.writable, d.enumerable, d.configurable, typeof d.get, typeof d.set, "value" in d ? String(d.value) : "-"].join("/"); }

const log: string[] = [];
const o: any = {};
const one: any = 1;
const empty: any = "";
try {
  Object.defineProperties(o, {
    a: { get value() { log.push("value"); return 1; }, get enumerable() { log.push("enumerable"); return true; } },
    b: { value: 2, enumerable: one, writable: empty },
  });
  console.log(o.a, o.b, desc(o, "a"), desc(o, "b"), log.join("|"));
} catch (e) { console.log("failed:", msg(e)); }

export {};
