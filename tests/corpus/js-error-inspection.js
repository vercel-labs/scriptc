// The same Error rendering over untyped JavaScript: fields a class declares,
// an Error cause, a late-added field on a plain Error, and console.error to
// stderr — the shapes untyped code actually produces.
// Error.stackTraceLimit = 0 keeps the stack frames out of the comparison.

Error.stackTraceLimit = 0;

class Retried extends Error {
  cause = "first attempt";
  retries = 2;
}
class Coded extends Error {
  code = "E_CODE";
}

console.log(new Retried("failed"));
console.log(new Coded("bad"));
console.error(new Retried("stderr"));

const cause = new Coded("inner");
const outer = new Error("outer", { cause });
console.log(outer);
console.log(outer.cause);

function late() {
  const e = new Error("late");
  e.when = "now";
  return e;
}
console.log(late());
