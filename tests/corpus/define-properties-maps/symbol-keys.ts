// Symbol keys on the map.
function msg(e: unknown): string { return e instanceof TypeError ? "TypeError: " + e.message : e instanceof Error ? "Error: " + e.message : String(e); }
function desc(o: object, k: string | symbol): string { const d = Object.getOwnPropertyDescriptor(o, k); return d === undefined ? "none" : [d.writable, d.enumerable, d.configurable, typeof d.get, typeof d.set, "value" in d ? String(d.value) : "-"].join("/"); }

const tag = Symbol("tag");
const hidden = Symbol("hidden");
const o: any = {};
try {
  Object.defineProperties(o, {
    [tag]: { value: "T", enumerable: true },
    name: { value: "n", enumerable: true },
    [hidden]: { get() { return "H"; } },
    [Symbol.toStringTag]: { value: "Tagged" },
  });
  console.log(o[tag], o[hidden], o.name, Object.keys(o).join(","), Object.getOwnPropertySymbols(o).length, desc(o, tag), desc(o, hidden), String(o));
} catch (e) { console.log("failed:", msg(e)); }

export {};
