// Accessor descriptors: get and set with the receiver as `this`, get only, set only, an arrow.
function msg(e: unknown): string { return e instanceof TypeError ? "TypeError: " + e.message : e instanceof Error ? "Error: " + e.message : String(e); }
function desc(o: object, k: string | symbol): string { const d = Object.getOwnPropertyDescriptor(o, k); return d === undefined ? "none" : [d.writable, d.enumerable, d.configurable, typeof d.get, typeof d.set, "value" in d ? String(d.value) : "-"].join("/"); }

const o: any = { store: 1 };
try {
  Object.defineProperties(o, {
    both: { get() { return this.store; }, set(v: number) { this.store = v * 2; }, enumerable: true, configurable: true },
    getOnly: { get() { return "g" + this.store; } },
    setOnly: { set(v: number) { this.store = v; } },
    arrow: { get: () => "arrow" },
  });
  o.both = 4;
  console.log(o.both, o.getOnly, o.setOnly, o.arrow);
  o.setOnly = 9;
  console.log(o.store, desc(o, "both"), desc(o, "getOnly"), desc(o, "setOnly"), Object.keys(o).join(","));
} catch (e) { console.log("failed:", msg(e)); }

export {};
