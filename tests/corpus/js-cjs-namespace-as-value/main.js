// A CommonJS binding used as a VALUE is the object `require` answers: the
// module's exports table, readable and callable through the binding.
const mod = require("./mod.js");
const echo = function (value) {
  return value;
};
console.log(typeof echo(mod), typeof mod);
console.log(mod.version, mod.name, typeof mod.helper);
const target = {};
mod.helper(target, "k", 1);
console.log(JSON.stringify(target));
