// A dynamic namespace over a module whose default export is an anonymous
// class, once a shipped .js module and once a .ts program module: the
// namespace must answer 'default' for dot and bracket reads, destructuring,
// the in operator and Object.keys, and the value must be the class itself.
// Node is the oracle.
const mod = await import("./ctor.js");
const def = mod.default;
const bracket = mod["default"];
const { default: Destructured, x } = mod;
console.log(typeof def, typeof bracket, typeof Destructured, x);
console.log("default" in mod, "missing" in mod);
console.log(Object.keys(mod).join(","));
console.log(def === bracket, bracket === Destructured);
const made = new def(21);
console.log(made.doubled());

const tmod = await import("./ctor-ts.ts");
const tdef = tmod["default"];
const { default: TDestructured, y } = tmod;
console.log(typeof tdef, typeof TDestructured, y, "default" in tmod, Object.keys(tmod).join(","));
console.log(new tdef().doubled());
