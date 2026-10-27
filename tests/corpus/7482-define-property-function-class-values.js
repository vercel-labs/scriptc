const desc = { value: undefined, enumerable: false };
function factory(name) {
  class Definition {}
  Object.defineProperty(Definition, "name", { value: name });
  function init(inst, def) {
    if (!inst._meta) {
      desc.value = { def, traits: new Set() };
      try {
        Object.defineProperty(inst, "_meta", desc);
      } finally {
        desc.value = undefined;
      }
    }
    inst._meta.traits.add(name);
  }
  function _(def) {
    const inst = this;
    init(inst, def);
    return inst;
  }
  Object.defineProperty(_, "init", { value: init });
  Object.defineProperty(_, Symbol.hasInstance, {
    value: (inst) => !!(inst && inst._meta && inst._meta.traits.has(name)),
  });
  Object.defineProperty(_, "name", { value: name });
  return { ctor: _, Definition };
}
const { ctor: Thing, Definition } = factory("Thing");
console.log(Definition.name, Thing.name, typeof Thing.init);
const t = new Thing({ a: 1 });
console.log(Object.keys(t), JSON.stringify(t), t._meta.def.a, [...t._meta.traits]);
console.log(t instanceof Thing, {} instanceof Thing);
const plain = {};
Thing.init(plain, { b: 2 });
console.log(plain instanceof Thing, Object.keys(plain), plain._meta.def.b);
