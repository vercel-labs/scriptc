// child.kill's name and the killSignal members match a signal name without
// regard to case: Node's convertToValidSignal uppercases the string before
// the lookup, so "sigkill" and "SigTerm" resolve like the uppercase
// spelling (an unknown literal name stays a compile-time fence).
import { spawn, spawnSync } from "node:child_process";

const child = spawn("sleep", ["5"]);
console.log("spawned", child.pid !== undefined);
console.log("kill", child.kill("sigkill"));
child.on("close", (code, signal) => {
  console.log("closed", code, signal);
});

const lower = spawnSync("sleep", ["5"], { timeout: 80, killSignal: "sigkill" });
const lowerError = lower.error ?? null;
console.log("spawnSync-lower", lower.signal, lowerError !== null, lowerError === null ? null : lowerError.message);

const mixed = spawnSync("sleep", ["5"], { timeout: 80, killSignal: "SigTerm" });
const mixedError = mixed.error ?? null;
console.log("spawnSync-mixed", mixed.signal, mixedError !== null, mixedError === null ? null : mixedError.message);
