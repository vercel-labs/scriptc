"use strict";
exports.get = () => process.exitCode;
exports.exit = (code) => process.exit(code);
exports.onExit = () => process.on("exit", (code) => console.log(`island exit ${code} ${process.exitCode}`));
