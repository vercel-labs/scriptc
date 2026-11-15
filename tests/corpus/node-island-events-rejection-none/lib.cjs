"use strict";
exports.install = () => process.on("exit", (code) => console.log(`island exit ${code} ${process.exitCode}`));
