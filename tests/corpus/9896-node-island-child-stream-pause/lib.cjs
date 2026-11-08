// Runs in the Node island.
const { spawn } = require("node:child_process");
exports.start = () =>
  spawn("sh", ["-c", "echo one; read x; echo two; read x; echo three"], { stdio: ["pipe", "pipe", "pipe"] });
