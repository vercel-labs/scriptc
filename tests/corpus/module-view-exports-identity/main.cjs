/* Node's Module object answers the module's own exports object: the view
 * require.cache holds for a module reads the same object the module's
 * `module.exports` reads, so identity and writes cross between them. */
module.exports.answer = 42;
const view = require.cache[__filename];
console.log("identity", view.exports === module.exports, view === module);
view.exports.added = "from the view";
console.log("writes", module.exports.added, view.exports.added, module.exports === view.exports);
module.exports.fromModule = 7;
console.log("mirror", view.exports.fromModule, module.exports.fromModule);
const viaView = require.cache[__filename].exports;
console.log("stable", viaView === view.exports, viaView === module.exports);
let keyCalls = 0;
const keyOf = () => {
  keyCalls += 1;
  return __filename;
};
const viaKey = require.cache[keyOf()];
console.log("key", keyCalls, viaKey.exports === module.exports, keyCalls);
