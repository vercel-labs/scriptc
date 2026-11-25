// Runs in the Node island: starts child processes for gc-children.ts.
const { spawn } = require("node:child_process");
const v8 = require("node:v8");
const vm = require("node:vm");
v8.setFlagsFromString("--expose-gc");
const gc = vm.runInNewContext("gc");
v8.setFlagsFromString("--no-expose-gc");
exports.start = (script) => spawn("sh", ["-c", script], { stdio: ["pipe", "pipe", "pipe"] });
// A full V8 collection, so the test reads what is held and not what the last
// scheduled collection happened to leave.
exports.collect = () => gc();
