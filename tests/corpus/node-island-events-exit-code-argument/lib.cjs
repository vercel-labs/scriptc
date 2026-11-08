"use strict";
exports.set = (code) => {
  process.exitCode = code;
};
exports.onExit = () => process.on("exit", (code) => console.log(`island exit ${code} ${process.exitCode}`));
