"use strict";
exports.leave = (code) => {
  console.log("leaving with", code);
  process.exit(code);
};
