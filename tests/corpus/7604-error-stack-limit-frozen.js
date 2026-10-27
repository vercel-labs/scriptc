// A frozen Error keeps stackTraceLimit read-only through the constructor
// held as a value.
const E = /** @type {any} */ (Error);
E.stackTraceLimit = 3;
Object.freeze(E);
try {
  E.stackTraceLimit = 1;
} catch {}
console.log(E.stackTraceLimit, Error.stackTraceLimit);
