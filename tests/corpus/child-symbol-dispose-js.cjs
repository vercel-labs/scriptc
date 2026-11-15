// The JavaScript spelling of ChildProcess[Symbol.dispose](): the method
// answers undefined, sends SIGTERM on a live child, and leaves an
// already-killed child alone. The receiver here is untyped, so the call
// goes through the dynamic member path.
const { spawn } = require("node:child_process");

const live = spawn("sleep", ["5"], { stdio: "ignore" });
const returned = live[Symbol.dispose]();
console.log("return", returned, returned === undefined);
console.log("live killed", live.killed);
live.on("close", (code, signal) => console.log("live close", code, signal));

const killed = spawn("sleep", ["5"], { stdio: "ignore" });
killed.kill("SIGKILL");
const second = killed[Symbol.dispose]();
console.log("second return", second, second === undefined, killed.killed);
killed.on("close", (code, signal) => console.log("killed close", code, signal));
