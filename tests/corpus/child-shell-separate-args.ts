// @normalize-pid
// The typed lane's shell forms join the file and its arguments the same way
// and report DEP0190 once.
import { execFile, spawn, spawnSync } from "node:child_process";

const captured = spawnSync("echo", ["x y"], { shell: true, encoding: "utf8" });
console.log("sync", captured.status, JSON.stringify(captured.stdout));

const spawned = spawn("echo", ["t u"], { shell: true });
console.log("args", JSON.stringify(spawned.spawnargs));
spawned.stdout?.on("data", (chunk) => console.log("spawn", JSON.stringify(String(chunk))));
spawned.on("close", () => {
  execFile("echo", ["v w"], { shell: true }, (error, stdout) => {
    console.log("execFile", error, JSON.stringify(stdout));
  });
});
