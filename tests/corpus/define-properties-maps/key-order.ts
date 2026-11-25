// Key order: integer keys ascending, then strings in insertion order, then symbols.
function msg(e: unknown): string { return e instanceof TypeError ? "TypeError: " + e.message : e instanceof Error ? "Error: " + e.message : String(e); }
function desc(o: object, k: string | symbol): string { const d = Object.getOwnPropertyDescriptor(o, k); return d === undefined ? "none" : [d.writable, d.enumerable, d.configurable, typeof d.get, typeof d.set, "value" in d ? String(d.value) : "-"].join("/"); }

const sym = Symbol("s");
const log: string[] = [];
const o: any = { pre: 0 };
const p: any = {};
const map: any = {};
for (const k of ["z", "10", "y", "9"]) {
  Object.defineProperty(map, k, { get() { log.push("read " + k); return { get() { return k; }, enumerable: true }; }, enumerable: true });
}
try {
  Object.defineProperties(o, {
    b: { value: 1, enumerable: true },
    [sym]: { value: 2, enumerable: true },
    2: { value: 3, enumerable: true },
    a: { value: 4, enumerable: true },
    1: { value: 5, enumerable: true },
  });
  console.log(Object.keys(o).join(","), Reflect.ownKeys(o).length);
  Object.defineProperties(p, map);
  console.log(Object.keys(p).join(","), log.join("|"));
} catch (e) { console.log("failed:", msg(e)); }

export {};
