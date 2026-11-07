// A class instance: redefining declared fields.
function msg(e: unknown): string { return e instanceof TypeError ? "TypeError: " + e.message : e instanceof Error ? "Error: " + e.message : String(e); }
function desc(o: object, k: string | symbol): string { const d = Object.getOwnPropertyDescriptor(o, k); return d === undefined ? "none" : [d.writable, d.enumerable, d.configurable, typeof d.get, typeof d.set, "value" in d ? String(d.value) : "-"].join("/"); }

class Point { x = 1; y = 2; sum(): number { return this.x + this.y; } }
const p = new Point();
try {
  const q = Object.defineProperties(p, { x: { value: 10 }, y: { value: 20, enumerable: false } });
  console.log(q === p, p.x, p.y, p.sum(), Object.keys(p).join(","), JSON.stringify(p));
} catch (e) { console.log("failed:", msg(e)); }

export {};
