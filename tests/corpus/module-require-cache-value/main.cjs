/* require.cache is one object for the process: the live module cache, whose
 * keys are the loaded modules' filenames in load order and whose values are
 * their Module objects. */
const cache = require.cache;
console.log("object", typeof cache, cache === require.cache);
console.log("proto", Object.getPrototypeOf(cache) === null, "toString" in cache);
console.log("initial", Object.keys(cache).length, Object.keys(cache)[0] === __filename);
const record = cache[__filename];
console.log("self", typeof record, record === module, record.exports === module.exports);
const child = require("./child.cjs");
const childFile = require.resolve("./child.cjs");
console.log("after", Object.keys(cache).length, cache[childFile] === module.children[0]);
console.log("child", typeof cache[childFile], child.tag, cache[childFile].parent === module);
try {
  require("./broken.cjs");
} catch (error) {
  console.log("broken", error.message);
}
console.log("dropped", Object.keys(cache).length);
