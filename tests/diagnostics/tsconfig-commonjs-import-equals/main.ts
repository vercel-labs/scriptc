// A project that tsc compiles to CommonJS and that uses the CommonJS-only
// import form. The file is an ES module for Node and for scriptc.
import path = require("path");
import os = require("os");

console.log(path.basename("/a/b.txt"), os.EOL.length);
