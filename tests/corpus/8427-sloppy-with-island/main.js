// @requires-libnode
// A sloppy CommonJS module that uses `with` runs in a Node island
// (DESIGN.md note 1 §3.2, decision S3): the native entry requires it, the
// island loads through Node at that position, and the program's stdout
// matches Node's byte for byte.
const lookup = require("./lookup.js");

console.log(lookup.describe({ first: "Ada", last: "Lovelace" }));
console.log(lookup.fallback({}), lookup.fallback({ first: "Grace" }));
console.log(lookup.shadowed(), lookup.nested({ outer: { inner: "deep" } }));
