// Order of errors: every descriptor is read before the first definition is attempted.
function msg(e: unknown): string { return e instanceof TypeError ? "TypeError: " + e.message : e instanceof Error ? "Error: " + e.message : String(e); }
function desc(o: object, k: string | symbol): string { const d = Object.getOwnPropertyDescriptor(o, k); return d === undefined ? "none" : [d.writable, d.enumerable, d.configurable, typeof d.get, typeof d.set, "value" in d ? String(d.value) : "-"].join("/"); }

const log: string[] = [];
const fixed: any = JSON.parse('{"a":1}');
Object.preventExtensions(fixed);
try {
  Object.defineProperties(fixed, {
    a: { value: 2 },
    added: { value: 3 },
    get late(): PropertyDescriptor { log.push("read late"); return { value: 4 }; },
  });
  console.log("no throw");
} catch (e) { console.log(msg(e)); }
console.log(fixed.a, log.join("|"));
const o: any = {};
try {
  Object.defineProperties(o, {
    first: { value: 1, enumerable: true },
    get thrower(): PropertyDescriptor { throw new Error("from the map getter"); },
  });
} catch (e) { console.log(msg(e)); }
console.log(Object.keys(o).length);
try {
  Object.defineProperties(o, {
    first: { value: 1, enumerable: true },
    second: { get value(): number { throw new RangeError("from the descriptor getter"); } },
  });
} catch (e) { console.log(msg(e)); }
console.log(Object.keys(o).length);

export {};
