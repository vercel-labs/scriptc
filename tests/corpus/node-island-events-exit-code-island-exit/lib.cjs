"use strict";
exports.exit = () => process.exit();
exports.onExit = () => process.on("exit", (code) => console.log(`island exit ${code} ${process.exitCode}`));
