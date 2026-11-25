/* A parameter named `module` is not the CommonJS module object: its
 * `require` is whatever the caller passed, so the call must reach THAT
 * function and use its result — the compiler's module.require intrinsic
 * only applies to the global module object. */
function through(module) {
  return module.require("./data.json");
}
const result = through({ require: (spec) => ({ value: "shadowed:" + spec }) });
console.log("shadowed", result.value);

const local = { require: (spec) => spec.toUpperCase() };
console.log("local", local.require("./x"));

console.log("global", module.require("./data.json").value);
