"use strict";
exports.argv = () => process.argv.slice(2);
exports.argc = () => process.argv.length;
exports.argv0 = () => typeof process.argv0;
exports.execArgv = () => process.execArgv.length;
