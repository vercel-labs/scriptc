// Runs in the Node island: starts child processes for gc-children.ts.
const { spawn } = require("node:child_process");
exports.start = (script) => spawn("sh", ["-c", script], { stdio: ["pipe", "pipe", "pipe"] });
