// Runs in the Node island.
const { spawn } = require("node:child_process");
exports.start = () => spawn("sh", ["-c", "exec sleep 30"], { stdio: ["pipe", "pipe", "pipe"] });
// Emits 'spawn' on the child once more, synchronously: an emit the program's listeners see again.
exports.emitSpawn = (child) => child.emit("spawn");
