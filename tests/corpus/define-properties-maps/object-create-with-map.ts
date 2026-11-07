// Object.create with a descriptor map: a literal, a variable, null.
function msg(e: unknown): string { return e instanceof TypeError ? "TypeError: " + e.message : e instanceof Error ? "Error: " + e.message : String(e); }
function desc(o: object, k: string | symbol): string { const d = Object.getOwnPropertyDescriptor(o, k); return d === undefined ? "none" : [d.writable, d.enumerable, d.configurable, typeof d.get, typeof d.set, "value" in d ? String(d.value) : "-"].join("/"); }

const proto = { greet(): string { return "hi"; } };
try {
  const made: any = Object.create(proto, { v: { value: 3, enumerable: true }, h: { get() { return 4; } } });
  console.log(made.v, made.h, made.greet(), Object.keys(made).join(","), Object.getPrototypeOf(made) === proto);
} catch (e) { console.log("failed:", msg(e)); }
const map = { n: { value: 1, enumerable: true } };
try {
  const bare: any = Object.create(null, map);
  console.log(bare.n, Object.keys(bare).join(","), Object.getPrototypeOf(bare) === null);
} catch (e) { console.log("failed:", msg(e)); }
const none: any = null;
try { Object.create(proto, none); console.log("no throw"); } catch (e) { console.log(msg(e)); }

export {};
