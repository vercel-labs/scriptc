// Feature probes on builtin constructor globals answer like Node.
const E = "captureStackTrace" in Error ? Error : null;
console.log(E === Error, "stackTraceLimit" in Error, "nope" in Error);
console.log("captureStackTrace" in TypeError, "keys" in Object, "fromAsync" in Array, "withResolvers" in Promise);
console.log("call" in Map, "hasOwnProperty" in Set, "groupBy" in Map, "groupBy" in Set, "now" in Date);
const capture = "captureStackTrace" in Error ? Error.captureStackTrace : () => {};
const target = {};
capture(target);
console.log(typeof target.stack);
