// A binding of the CommonJS `module` object (and of require.main) holds
// Node's Module object: identity comparisons, member reads, captures and
// the untyped conversions answer the object, as Node's do.
require("./child.cjs");
const top = module;
const topMain = require.main;
console.log("top", top === module, topMain === module, typeof top);
console.log("member", top.id.length > 0, top.children.length, top.loaded);
function inner() {
  const view = module;
  const read = () => view.children.length;
  return read() === module.children.length;
}
console.log("captured", inner());
console.log("string", String(module), "exports" in module);
const child = module.children[0];
console.log("child", child.parent.id === module.id, child.id.endsWith("child.cjs"));
let reassigned = module;
reassigned = require.main;
console.log("reassigned", reassigned === module);
