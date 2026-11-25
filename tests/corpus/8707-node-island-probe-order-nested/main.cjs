// @requires-libnode
// The first island load of the program sits inside an expression: a
// require() whose member is compared. The build probes island modules in
// the order the program evaluates them, and has to find that load where the
// expression is: pkg-a and pkg-b share a file whose evaluation prints, and
// Node evaluates it here, before the native module required next. Probed
// after pkg-b, pkg-a's load would look empty and be deferred past it.
const isFunction = typeof require("pkg-a").a === "function";
require("./between.cjs");
const { kind } = require("./dep.cjs");

console.log("main", isFunction, kind);
