"use strict";
exports.exitLater = (ms, code) => setTimeout(() => {
  console.log("island exits");
  process.exit(code);
}, ms);
