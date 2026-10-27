// Error.stackTraceLimit through the Error constructor held as a value
// (zod 4's `const E = "captureStackTrace" in Error ? Error : null`): reads
// and writes reach the same limit as the static member.
const E = "captureStackTrace" in Error ? Error : null;
console.log(typeof E, E === Error, E.stackTraceLimit, Error.stackTraceLimit);
const saved = E.stackTraceLimit;
E.stackTraceLimit = 0;
console.log(Error.stackTraceLimit, E.stackTraceLimit, typeof saved === "number");
console.log(new Error("no frames").stack);
try {
  E.stackTraceLimit = 3;
  console.log(Error.stackTraceLimit);
} finally {
  E.stackTraceLimit = saved;
}
console.log(E.stackTraceLimit, Error.stackTraceLimit);
Error.stackTraceLimit = 4;
console.log(E.stackTraceLimit);
