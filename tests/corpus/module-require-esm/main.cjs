/* Node 24's require(esm): a CommonJS module requires an ES module graph
 * synchronously — named exports, the namespace's default — and an
 * asynchronous graph throws Node's ERR_REQUIRE_ASYNC_MODULE at the require
 * site, with the required module and the require stack. */
const mod = require("./child.mjs");
console.log("named", mod.v, JSON.stringify(mod.default));

try {
  require("./tla.mjs");
} catch (error) {
  console.log("tla", error.name, error.code, error.message);
}
