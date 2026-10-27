// An own stackTraceLimit on the Error constructor held as a value (a
// non-number assigned, or one defined with Object.defineProperty) answers
// reads through the value, and writes to it keep its descriptor.
const E = /** @type {any} */ (Error);
E.stackTraceLimit = "deep";
console.log(E.stackTraceLimit, typeof E.stackTraceLimit);
E.stackTraceLimit = 2;
console.log(E.stackTraceLimit, Error.stackTraceLimit);
Object.defineProperty(E, "stackTraceLimit", { value: 6, writable: false, configurable: true });
try {
  E.stackTraceLimit = 1;
} catch {}
console.log(E.stackTraceLimit);
