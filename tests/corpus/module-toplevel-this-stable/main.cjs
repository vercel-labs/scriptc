/* Node keeps a module's top-level `this` as the original exports object for
 * the module's life: replacing module.exports does not rebind it. */
const original = this;
module.exports = { replaced: true };
console.log("keys", Object.keys(original).join(","), original.replaced);
