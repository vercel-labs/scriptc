// Runs in the Node island.
const { spawn, ChildProcess } = require("node:child_process");
let kept;
exports.start = (script) => (kept = spawn("sh", ["-c", script], { stdio: ["pipe", "pipe", "pipe"] }));
exports.kept = () => kept;
exports.isKept = (value) => value === kept;
exports.isChild = (value) => value instanceof ChildProcess;
exports.count = (child, event) => child.listenerCount(event);
exports.onExit = (child, listener) => child.on("exit", listener);
