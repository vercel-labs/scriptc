// Frozen, sealed and non-extensible objects: the TypeErrors.
function msg(e: unknown): string { return e instanceof TypeError ? "TypeError: " + e.message : e instanceof Error ? "Error: " + e.message : String(e); }
function desc(o: object, k: string | symbol): string { const d = Object.getOwnPropertyDescriptor(o, k); return d === undefined ? "none" : [d.writable, d.enumerable, d.configurable, typeof d.get, typeof d.set, "value" in d ? String(d.value) : "-"].join("/"); }

const frozen: any = JSON.parse('{"a":1}');
Object.freeze(frozen);
try { Object.defineProperties(frozen, { b: { value: 2 } }); console.log("no throw", frozen.b); } catch (e) { console.log("frozen new:", msg(e)); }
try { Object.defineProperties(frozen, { a: { value: 2 } }); console.log("no throw", frozen.a); } catch (e) { console.log("frozen change:", msg(e)); }
try { console.log("frozen same:", Object.defineProperties(frozen, { a: { value: 1 } }) === frozen); } catch (e) { console.log("frozen same:", msg(e)); }
const sealed: any = JSON.parse('{"a":1}');
Object.seal(sealed);
try {
  Object.defineProperties(sealed, { a: { value: 3 } });
  console.log("sealed value:", sealed.a);
  Object.defineProperties(sealed, { a: { enumerable: false } });
  console.log("no throw");
} catch (e) { console.log("sealed attr:", msg(e)); }
const fixed: any = JSON.parse('{"a":1}');
Object.preventExtensions(fixed);
try { Object.defineProperties(fixed, { a: { value: 4 }, z: { value: 1 } }); console.log("no throw"); } catch (e) { console.log("not extensible:", msg(e), fixed.a); }

export {};
