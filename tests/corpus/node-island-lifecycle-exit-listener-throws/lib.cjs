"use strict";
exports.onExitThrow = () => process.on("exit", (code) => {
  console.log(`island exit listener ${code} throws`);
  throw new Error("island exit listener threw");
});
exports.onExit = (label) => process.on("exit", (code) => console.log(`island exit listener ${label} ${code}`));
exports.exit = (code) => process.exit(code);
