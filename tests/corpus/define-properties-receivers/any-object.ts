// An untyped object, and a parsed one behind `unknown`.
function msg(e: unknown): string { return e instanceof TypeError ? "TypeError: " + e.message : e instanceof Error ? "Error: " + e.message : String(e); }
function desc(o: object, k: string | symbol): string { const d = Object.getOwnPropertyDescriptor(o, k); return d === undefined ? "none" : [d.writable, d.enumerable, d.configurable, typeof d.get, typeof d.set, "value" in d ? String(d.value) : "-"].join("/"); }

const o: any = { a: 1 };
const same = Object.defineProperties(o, {
  b: { value: 2, enumerable: true },
  c: { get() { return this.a + 10; }, set(v: number) { this.a = v; }, enumerable: true },
});
o.c = 5;
console.log(same === o, o.a, o.b, o.c, Object.keys(o).join(","), JSON.stringify(o));
const parsed: unknown = JSON.parse('{"a":1}');
const again = Object.defineProperties(parsed as object, { b: { value: 2 } }) as any;
console.log(again === parsed, again.a, again.b, Object.keys(again).join(","));

export {};
