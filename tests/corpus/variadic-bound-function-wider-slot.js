// A bound function in a JavaScript module: the checker infers its type from
// the bind call, and the callers that pass more arguments reach the bound
// callable, exactly as in a TypeScript module.
function resolve(a, b) {
  console.log("resolve", a, b);
}
const bound = resolve.bind(null, "x", 1);
function take(cb) {
  cb("ignored");
}
take(bound);
[1, 2].forEach(bound);
