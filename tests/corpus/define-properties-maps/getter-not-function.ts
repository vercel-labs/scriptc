// A getter or setter that is not a function: a TypeError before any property is defined.
function msg(e: unknown): string { return e instanceof TypeError ? "TypeError: " + e.message : e instanceof Error ? "Error: " + e.message : String(e); }
function desc(o: object, k: string | symbol): string { const d = Object.getOwnPropertyDescriptor(o, k); return d === undefined ? "none" : [d.writable, d.enumerable, d.configurable, typeof d.get, typeof d.set, "value" in d ? String(d.value) : "-"].join("/"); }

const o: any = {};
const one: any = 1;
const text: any = "x";
try { Object.defineProperties(o, { ok: { value: 1, enumerable: true }, g: { get: one } }); console.log("no throw"); } catch (e) { console.log(e instanceof TypeError, Object.keys(o).length); }
try { Object.defineProperties(o, { s: { set: text } }); console.log("no throw"); } catch (e) { console.log(e instanceof TypeError, Object.keys(o).length); }
try { Object.defineProperties(o, { u: { get: undefined, set: undefined, enumerable: true } }); console.log(o.u, desc(o, "u")); } catch (e) { console.log(msg(e)); }

export {};
