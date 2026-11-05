// Node ignores SIGPIPE and SIGXFSZ: the process keeps running when either
// arrives, and spawned children start with both at their default actions,
// through each spawn path. write-signals-listener.mjs covers a listener.
import { execFileSync, spawn, spawnSync } from "node:child_process";

process.kill(process.pid, "SIGPIPE");
process.kill(process.pid, "SIGXFSZ");
console.log("ignored");

for (const name of ["PIPE", "XFSZ"]) {
  const child = spawnSync("/bin/sh", ["-c", `kill -${name} $$; echo survived`], {
    encoding: "utf8",
  });
  console.log("spawnSync", name, child.status, child.signal, JSON.stringify(child.stdout));
}

try {
  execFileSync("/bin/sh", ["-c", "kill -PIPE $$; echo survived"], { encoding: "utf8" });
  console.log("execFileSync survived");
} catch (error) {
  console.log("execFileSync", (error as { signal?: string }).signal);
}

const child = spawn("/bin/sh", ["-c", "kill -XFSZ $$; echo survived"]);
let output = "";
child.stdout!.setEncoding("utf8");
child.stdout!.on("data", (chunk: string) => (output += chunk));
child.on("exit", (code, signal) => {
  console.log("spawn", code, signal, JSON.stringify(output));
});
