const _desc = { value: undefined, enumerable: false };
function $constructor(name, initializer, params) {
  const proto = {};
  function Internals(def) {
    this.def = def;
    this.constr = _;
    this.traits = new Set();
  }
  Internals.prototype = proto;
  function init(inst, def) {
    if (!inst._zod) {
      _desc.value = new Internals(def);
      try {
        Object.defineProperty(inst, "_zod", _desc);
      } finally {
        _desc.value = undefined;
      }
    } else if (inst._zod.traits.has(name)) {
      return;
    }
    inst._zod.traits.add(name);
    initializer(inst, def);
  }
  const Parent = params?.Parent ?? Object;
  class Definition extends Parent {}
  Object.defineProperty(Definition, "name", { value: name });
  function _(def) {
    const inst = params?.Parent ? new Definition() : this;
    init(inst, def);
    return inst;
  }
  Object.defineProperty(_, "init", { value: init });
  Object.defineProperty(_, Symbol.hasInstance, {
    value: (inst) => {
      if (params?.Parent && inst instanceof params.Parent) return true;
      return inst?._zod?.traits?.has(name);
    },
  });
  Object.defineProperty(_, "name", { value: name });
  return _;
}
const $Base = $constructor("$Base", (inst, def) => {
  inst.kind = def.kind;
  inst._zod.parse = (v) => (typeof v === def.kind ? { value: v } : { issues: [`expected ${def.kind}`] });
});
const $Str = $constructor("$Str", (inst, def) => {
  $Base.init(inst, def);
  inst.min = def.min;
});
const $Err = $constructor("$Err", (inst, def) => {
  inst.issues = def;
  inst.message = JSON.stringify(def);
}, { Parent: Error });
const s = new $Str({ kind: "string", min: 2 });
console.log(s.kind, s.min, [...s._zod.traits], s instanceof $Str, s instanceof $Base, Object.keys(s));
console.log(JSON.stringify(s._zod.parse("ab")), JSON.stringify(s._zod.parse(3)));
const e = new $Err(["bad"]);
console.log(e instanceof $Err, e.issues, e.message, $Str.name, $Err.name);
