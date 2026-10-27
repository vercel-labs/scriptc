// typeof on functions and classes exported by Node builtin modules, read
// through require bindings: Node answers "function" for each.
const zlib = require("node:zlib");
const path = require("node:path");
const fs = require("node:fs");
console.log(typeof zlib.createGzip, typeof zlib.createBrotliDecompress, typeof zlib.gunzipSync);
console.log(typeof zlib.Inflate, typeof zlib.Gzip, typeof zlib.DeflateRaw);
console.log(typeof path.join, typeof path.posix.join, typeof fs.readFileSync);
console.log(typeof path.sep);
