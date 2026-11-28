// Error.prepareStackTrace is program state. A program may save the default,
// replace it with undefined or a non-callable value (Node formats with its own
// formatter then) and restore it.
const saved = Error.prepareStackTrace;
console.log(typeof saved);

Error.prepareStackTrace = undefined;
const disabled = new Error("disabled");
console.log(typeof disabled.stack, disabled.stack.split("\n")[0]);

Error.prepareStackTrace = 42;
const numeric = new Error("numeric");
console.log(typeof numeric.stack, numeric.stack.split("\n")[0]);

Error.prepareStackTrace = {};
const object = new Error("object");
console.log(typeof object.stack, object.stack.split("\n")[0]);

Error.prepareStackTrace = saved;
console.log(Error.prepareStackTrace === saved);

const limit = Error.stackTraceLimit;
Error.stackTraceLimit = 0;
const limited = new Error("limited");
console.log(JSON.stringify(limited.stack));
Error.stackTraceLimit = limit;
