// Runs in the Node island: a package that starts a child process and hands it back, as a spawn wrapper does.
const { spawn } = require("node:child_process");
exports.start = (command, args) => spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
