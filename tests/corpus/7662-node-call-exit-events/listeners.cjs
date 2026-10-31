"use strict";
let beforeExit = 0;

exports.register = () => {
  process.on("beforeExit", (code) => {
    beforeExit++;
    console.log("beforeExit", code, beforeExit);
    if (beforeExit === 1) setTimeout(() => console.log("work from beforeExit"), 1);
  });
  process.on("exit", (code) => console.log("exit", code));
  process.exitCode = 4;
  return true;
};
