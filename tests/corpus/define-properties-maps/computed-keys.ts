// Computed keys on the map.
function msg(e: unknown): string { return e instanceof TypeError ? "TypeError: " + e.message : e instanceof Error ? "Error: " + e.message : String(e); }
function desc(o: object, k: string | symbol): string { const d = Object.getOwnPropertyDescriptor(o, k); return d === undefined ? "none" : [d.writable, d.enumerable, d.configurable, typeof d.get, typeof d.set, "value" in d ? String(d.value) : "-"].join("/"); }

function key(n: number): string { return "k" + n; }
const o: any = {};
const name: string = ["dyn", "amic"].join("");
try {
  Object.defineProperties(o, {
    [key(1)]: { value: 1, enumerable: true },
    [name]: { value: 2, enumerable: true },
    ["lit" + "eral"]: { get() { return 3; }, enumerable: true },
    [10 + 1]: { value: 4, enumerable: true },
  });
  console.log(o.k1, o.dynamic, o.literal, o[11], Object.keys(o).join(","));
} catch (e) { console.log("failed:", msg(e)); }

export {};
