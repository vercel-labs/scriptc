// Runs in the Node island.
const { spawn } = require("node:child_process");
exports.start = (command) => spawn(command, [], { stdio: ["pipe", "pipe", "pipe"] });
