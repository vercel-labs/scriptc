/* A parameter or local named `require` is the caller's loader, not the
 * CommonJS global: an intrinsic replacement would skip it. Each spelling
 * below must call the value the caller supplied and use its result. */
function through(require) {
  return require("node:path");
}
console.log("returned", through((spec) => "loader:" + spec));

function inline(require) {
  return { value: require("./data") };
}
console.log("inline", inline((spec) => spec.toUpperCase()).value);

const local = { require: (spec) => "local:" + spec };
console.log("method", local.require("x"));

console.log("global", require("node:path").basename("/a/b.txt"));
