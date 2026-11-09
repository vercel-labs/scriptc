// The global object found by a function and handed on as a value.
function findRoot() {
  return (typeof globalThis === "object" && globalThis) || (typeof global === "object" && global) || {};
}
module.exports = findRoot();
