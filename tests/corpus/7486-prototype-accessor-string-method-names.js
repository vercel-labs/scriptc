function own(inst, key, value, enumerable = true) {
  Object.defineProperty(inst, key, { configurable: true, writable: true, enumerable, value });
  return value;
}
function defineBound(proto, key, fn) {
  Object.defineProperty(proto, key, {
    configurable: true,
    get() {
      return this == null ? fn : own(this, key, fn.bind(this));
    },
    set(value) {
      own(this, key, value);
    },
  });
}
function members(proto, table) {
  for (const key in table) {
    const desc = Object.getOwnPropertyDescriptor(table, key);
    if (desc.get) Object.defineProperty(proto, key, { ...desc, enumerable: false });
    else defineBound(proto, key, desc.value);
  }
}
function Schema(def) {
  this.def = def;
}
let installed = false;
function make(def) {
  const inst = new Schema(def);
  if (!installed) {
    installed = true;
    members(Object.getPrototypeOf(inst), {
      min(n) { return make({ ...this.def, min: n }); },
      max(n) { return make({ ...this.def, max: n }); },
      trim() { return make({ ...this.def, trim: true }); },
      get size() { return Object.keys(this.def).length; },
    });
  }
  return inst;
}
const s = make({ kind: "string" }).min(1).max(200).trim();
console.log(JSON.stringify(s.def), s.size, Object.keys(s), typeof s.trim);
const detached = make({ kind: "x" }).max;
console.log(JSON.stringify(detached(3).def));
const proto2 = {};
Object.defineProperty(proto2, "aaa", { configurable: true, get() { return () => "custom-aaa"; } });
Object.defineProperty(proto2, "trim", { configurable: true, get() { return () => "custom-trim"; } });
Object.defineProperty(proto2, "trimx", { configurable: true, get() { return () => "custom-trimx"; } });
Object.defineProperty(proto2, "slice", { configurable: true, get() { return () => "custom-slice"; } });
const o2 = Object.create(proto2);
console.log(o2.aaa());
console.log(o2.trimx());
console.log(o2.slice());
console.log(o2.trim());
