// os.getPriority and os.setPriority read as values and called through an
// untyped helper: the function carries Node's name and length, and its
// argument checks are the same ones the direct calls run (the default pid,
// setPriority's one-argument shift, and validateInteger's type error).
const os = require("node:os");

const getPriority = os.getPriority;
const setPriority = os.setPriority;

function attempt(label, fn, ...args) {
  try {
    console.log(label, "ok", typeof fn.apply(null, args));
  } catch (e) {
    console.log(label, "throw", e.name, e.code, e.message);
  }
}

console.log("identity", getPriority === os.getPriority, setPriority === os.setPriority);
console.log("length", getPriority.length, setPriority.length);
console.log("name", getPriority.name, setPriority.name);
console.log("default", getPriority() === os.getPriority(0));
console.log("undefined pid", getPriority(undefined) === os.getPriority());

attempt("string pid", getPriority, "1");
attempt("boolean pid", getPriority, true);
attempt("array pid", getPriority, [1]);
attempt("fraction pid", getPriority, 1.5);

attempt("no arguments", setPriority);
attempt("string priority", setPriority, "-5");
attempt("string pid", setPriority, 0, "1");
attempt("both invalid", setPriority, "pid", "priority");
attempt("undefined priority", setPriority, 0, undefined);
attempt("self", setPriority, os.getPriority());
console.log("priority unchanged", os.getPriority() === getPriority());
