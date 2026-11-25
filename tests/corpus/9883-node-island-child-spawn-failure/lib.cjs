// Runs in the Node island.
const { spawn } = require("node:child_process");
exports.start = (command, args) => spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
