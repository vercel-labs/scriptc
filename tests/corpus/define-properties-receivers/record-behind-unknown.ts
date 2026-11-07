// A typed record held as an untyped value: a new key, and a declared key's value.
function msg(e: unknown): string { return e instanceof TypeError ? "TypeError: " + e.message : e instanceof Error ? "Error: " + e.message : String(e); }
function desc(o: object, k: string | symbol): string { const d = Object.getOwnPropertyDescriptor(o, k); return d === undefined ? "none" : [d.writable, d.enumerable, d.configurable, typeof d.get, typeof d.set, "value" in d ? String(d.value) : "-"].join("/"); }

interface P { x: number; y: number }
const point: P = { x: 1, y: 2 };
const untyped: unknown = point;
try {
  const same = Object.defineProperties(untyped as object, { z: { value: 3, enumerable: true }, x: { value: 10 } });
  console.log(same === untyped, Object.keys(same).join(","), desc(same, "z"), JSON.stringify(untyped), point.x, point.y);
} catch (e) { console.log("failed:", msg(e)); }

export {};
