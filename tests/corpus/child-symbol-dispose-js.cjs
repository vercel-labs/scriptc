// The JavaScript spelling of ChildProcess[Symbol.dispose](): the method
// answers undefined, sends SIGTERM on a live child, and leaves an
// already-killed child alone. The receiver here is untyped, so the call
// goes through the dynamic member path.
//
// The two children exit independently — SIGKILL for the killed one, SIGTERM
// for the disposed one — and which close event arrives first is the host's,
// so both are reported together once both have arrived, in one fixed order.
const { spawn } = require("node:child_process");

const closes = {};
const reportClose = (which, code, signal) => {
  closes[which] = { code, signal };
  if (closes.live === undefined || closes.killed === undefined) return;
  console.log("killed close", closes.killed.code, closes.killed.signal);
  console.log("live close", closes.live.code, closes.live.signal);
};

const live = spawn("sleep", ["5"], { stdio: "ignore" });
const returned = live[Symbol.dispose]();
console.log("return", returned, returned === undefined);
console.log("live killed", live.killed);
live.on("close", (code, signal) => reportClose("live", code, signal));

const killed = spawn("sleep", ["5"], { stdio: "ignore" });
killed.kill("SIGKILL");
const second = killed[Symbol.dispose]();
console.log("second return", second, second === undefined, killed.killed);
killed.on("close", (code, signal) => reportClose("killed", code, signal));
