// Runs in the Node island.
const { spawn } = require("node:child_process");
exports.start = (script) => spawn("sh", ["-c", script], { stdio: ["pipe", "pipe", "pipe"] });
