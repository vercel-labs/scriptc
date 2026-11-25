// An object with a null prototype.
function msg(e: unknown): string { return e instanceof TypeError ? "TypeError: " + e.message : e instanceof Error ? "Error: " + e.message : String(e); }
function desc(o: object, k: string | symbol): string { const d = Object.getOwnPropertyDescriptor(o, k); return d === undefined ? "none" : [d.writable, d.enumerable, d.configurable, typeof d.get, typeof d.set, "value" in d ? String(d.value) : "-"].join("/"); }

const o: any = Object.create(null);
try {
  const same = Object.defineProperties(o, { a: { value: 1, enumerable: true }, b: { get() { return 2; } } });
  console.log(same === o, o.a, o.b, Object.keys(o).join(","), Object.getPrototypeOf(o) === null);
} catch (e) { console.log("failed:", msg(e)); }

export {};
