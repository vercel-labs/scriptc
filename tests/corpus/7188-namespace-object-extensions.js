// Namespace objects take new properties and attribute-only redefinitions
// as in Node, and their members keep the values static calls use.
const m = Math;
m.tau = 2 * Math.PI;
console.log(m.tau.toFixed(4), Math.tau === m.tau, "tau" in Math, Object.keys(Math).join(","));
Object.defineProperty(Math, "hypot", { enumerable: true });
Object.defineProperty(Math, "trunc", { value: Math.trunc, writable: false });
const d = Object.getOwnPropertyDescriptor(Math, "trunc");
console.log(Object.keys(Math).join(","), d.writable, d.enumerable, d.configurable, Math.trunc(-1.5));
console.log(Math.hypot(3, 4), m.hypot === Math.hypot, Object.getOwnPropertyDescriptor(m, "hypot").enumerable);
const j = JSON;
j.label = "json";
console.log(j.label, Object.keys(JSON).join(","), Reflect.ownKeys(j).length);
const r = Reflect;
r.extra = [1, 2];
console.log(Reflect.extra.length, Object.getOwnPropertyNames(Reflect).at(-1), "extra" in r);
