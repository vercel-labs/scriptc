// A file-scope binding initialised from a checked-dynamic CommonJS export
// reads that export's storage. Collection asks the same question to type the
// binding, before any module's %init is named: the type probe must not lower
// the require's module initialiser there, or the binding registers as a form
// with no lowering and a later read defers to run time.
const state = require("./state.cjs").state;

function describe() {
  return state.mode;
}

console.log(describe());
state.mode = "fast";
console.log(describe());
