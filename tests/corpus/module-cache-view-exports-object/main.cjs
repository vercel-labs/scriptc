/* A module that only assigns exports properties has no top-level `this`, but
 * a value use of its exports object still materializes one: the registry
 * entry a cache view reads holds that same object. */
const child = require("./child.cjs");
const childFile = require.resolve("./child.cjs");
const use = (value) => Object.keys(value).length;
console.log("used", use(child));
console.log(
  "view",
  require.cache[childFile].exports === child,
  require.cache[childFile].exports.answer,
);
