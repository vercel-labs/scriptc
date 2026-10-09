// Errors held in checked-dynamic slots (a caught value, an 'unknown'
// binding, a record field) print through console.log/console.error with
// Node's error rendering. Stack traces are disabled so both runtimes print
// the stackless bracket form.
Error.stackTraceLimit = 0;

try {
  JSON.parse("");
} catch (err) {
  console.error("failed:", err);
  console.log(err);
  console.log("message:", (err as Error).message);
}

const stored: unknown = new RangeError("out of range");
console.log(stored);
console.log([stored]);

function fail(code: number): never {
  throw new TypeError(`bad input ${code}`);
}
try {
  fail(7);
} catch (e) {
  console.log({ caught: e });
  console.error("handled", e);
}
