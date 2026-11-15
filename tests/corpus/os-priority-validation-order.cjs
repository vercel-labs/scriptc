// os.setPriority's argument checks in Node's order: validateInt32(pid,
// 'pid') runs to completion — the type, then that it is an integer, then
// the int32 range — before the priority is looked at, so an invalid pid
// wins even when the priority is not a number. The one-argument form moves
// the first argument into the priority slot and validates the default pid
// first.
const os = require("node:os");

function attempt(label, fn) {
  try {
    console.log(label, "ok", typeof fn());
  } catch (e) {
    console.log(label, "throw", e.name, e.code, e.message);
  }
}

attempt("fraction pid, string priority", () => os.setPriority(1.5, "1"));
attempt("fraction pid, object priority", () => os.setPriority(1.5, {}));
attempt("out of range pid, string priority", () => os.setPriority(2 ** 31, "1"));
attempt("string pid, string priority", () => os.setPriority("1", "-5"));
attempt("fraction pid, fraction priority", () => os.setPriority(1.5, 2.5));
attempt("valid pid, fraction priority", () => os.setPriority(0, 0.5));
attempt("valid pid, out of range priority", () => os.setPriority(0, 100));
attempt("one argument fraction", () => os.setPriority(1.5));
attempt("one argument string", () => os.setPriority("1"));
attempt("one argument out of range", () => os.setPriority(2 ** 31));
