"use strict";
exports.log = (s) => console.log(s);
exports.write = (s) => process.stdout.write(s);
exports.err = (s) => console.error(s);
exports.errWrite = (s) => process.stderr.write(s);
exports.info = (s) => console.info(s);
exports.warn = (s) => console.warn(s);
exports.fsWrite = (s) => require("node:fs").writeSync(1, s);
