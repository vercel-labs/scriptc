"use strict";
exports.big = (ch, n) => process.stdout.write(ch.repeat(n) + "\n");
exports.exit = (c) => process.exit(c);
exports.onExit = () => process.on("exit", () => {
  process.stdout.write("island exit listener writes\n");
  console.error("island exit listener stderr");
});
