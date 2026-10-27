"use strict";
const { spawn } = require("child_process");
module.exports = function start() {
  return spawn(process.execPath, [process.argv[1], "child"]);
};
