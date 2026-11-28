const mod = await import("./named.js");
const def = mod.default;
const bracket = mod["default"];
const { default: destructured, x } = mod;
console.log(typeof def, typeof bracket, typeof destructured, x);
console.log("default" in mod, "missing" in mod);
console.log(Object.keys(mod).join(","));
console.log(def === bracket, bracket === destructured);
