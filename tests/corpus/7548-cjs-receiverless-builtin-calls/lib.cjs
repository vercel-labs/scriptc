"use strict";
Object.defineProperty(exports, "__esModule", { value: !0 });
exports.label = exports.describe = void 0;
const node_util_1 = require("node:util");
const node_path_1 = require("node:path");
function describe(name, size) {
  return (0, node_util_1.format)("%s holds %d (%s)", name, size, (0, node_path_1.basename)("/a/b/c.txt"));
}
exports.describe = describe;
exports.label = "lib";
