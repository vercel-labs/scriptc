// os.getPriority/os.setPriority with the number arguments untyped
// JavaScript supplies: the pid slot absent or undefined selects the 1-arg
// form, undefined is a default rather than an error where Node accepts it,
// the argument checks answer Node's error codes and messages, and the
// arguments are evaluated left to right before the call.
const os = require("node:os");

function attempt(label, fn) {
  try {
    const value = fn();
    console.log(label, "ok", typeof value);
  } catch (e) {
    console.log(label, "throw", e.name, e.code, e.message);
  }
}

const self = os.getPriority();
console.log("default is pid 0", os.getPriority() === os.getPriority(0));
console.log("own pid", os.getPriority(process.pid) === self);
console.log("undefined pid", os.getPriority(undefined) === self);
console.log("void 0 pid", os.getPriority(void 0) === self);
console.log("integer", Number.isInteger(self) && self <= 19);

attempt("null pid", () => os.getPriority(null));
attempt("fraction pid", () => os.getPriority(1.5));
attempt("NaN pid", () => os.getPriority(Number.NaN));
attempt("out of range pid", () => os.getPriority(2 ** 31));
attempt("string pid", () => os.getPriority("1"));

attempt("no arguments", () => os.setPriority());
attempt("fraction priority", () => os.setPriority(0.5));
attempt("out of range priority", () => os.setPriority(100));
attempt("string priority", () => os.setPriority("-5"));
attempt("out of range pid", () => os.setPriority(0, 2 ** 31));
attempt("string pid", () => os.setPriority(0, "1"));
attempt("own priority", () => os.setPriority(self));

// The second argument undefined means the 1-arg form: the priority lands on
// the calling process, and the undefined slot is still evaluated first.
const order = [];
function arg(name, value) {
  order.push(name);
  return value;
}
attempt("priority with undefined pid", () => os.setPriority(arg("priority", 19), arg("pid", undefined)));
console.log("priority raised", os.getPriority() === 19);
console.log("order", order.join(","));
attempt("restore", () => os.setPriority(self));
console.log("restored", os.getPriority() === self);
