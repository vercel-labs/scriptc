// JavaScript: a literal map with a symbol key, a getter, an accessor, a computed and a numeric key.
function msg(e) { return e instanceof TypeError ? "TypeError: " + e.message : e instanceof Error ? "Error: " + e.message : String(e); }
function desc(o, k) { const d = Object.getOwnPropertyDescriptor(o, k); return d === undefined ? "none" : [d.writable, d.enumerable, d.configurable, typeof d.get, typeof d.set, "value" in d ? String(d.value) : "-"].join("/"); }

const sym = Symbol("s");
const log = [];
try {
  const o = { store: 1 };
  const same = Object.defineProperties(o, {
    b: { value: 2, enumerable: true },
    [sym]: { value: "S", enumerable: true },
    get viaGetter() { log.push("read viaGetter"); return { value: 3, enumerable: true }; },
    acc: { get() { return this.store + 10; }, set(v) { this.store = v; }, enumerable: true },
    ["comp" + "uted"]: { value: 4 },
    7: { value: 5, enumerable: true },
  });
  o.acc = 5;
  console.log(same === o, o.b, o[sym], o.viaGetter, o.acc, o.computed, o[7], Object.keys(o).join(","), log.join("|"));
  console.log(desc(o, sym), desc(o, "acc"), desc(o, "computed"), Object.getOwnPropertySymbols(o).length);
} catch (e) { console.log("failed:", msg(e)); }
