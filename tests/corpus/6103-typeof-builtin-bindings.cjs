// typeof on bindings destructured from Node builtin modules: Node answers by
// the export's kind ("function" for functions and classes, "object" for
// namespace objects), never by how the binding is represented.
const { inspect, format, promisify, deprecate, isDeepStrictEqual } = require("util");
const { join, resolve } = require("path");
const { readFileSync, promises } = require("fs");
const { EventEmitter } = require("events");
const { createHash } = require("crypto");
const util = require("node:util");
const { inspect: aliased } = util;
console.log(typeof inspect, typeof format, typeof promisify, typeof deprecate, typeof isDeepStrictEqual);
console.log(typeof join, typeof resolve, typeof readFileSync, typeof promises);
console.log(typeof EventEmitter, typeof createHash, typeof aliased, typeof util.inspect);
console.log(typeof inspect === "function" ? "callable" : "not callable");
console.log(join("a", "b"), format("%s=%d", "x", 1), inspect({ a: [1, 2] }));
