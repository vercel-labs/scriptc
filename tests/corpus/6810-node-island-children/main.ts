// @requires-libnode
// Children of both sides: island code's first spawn installs libuv's SIGCHLD
// handler, and the program's own children are still reaped (scriptc waits
// for its pids itself, libuv only reaps its own).
import { call } from "@scriptc/node";
import { spawn, spawnSync } from "node:child_process";

function nativeChild(): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn("/bin/sh", ["-c", "echo native child; exit 3"], {
      stdio: ["ignore", "inherit", "inherit"],
    });
    child.on("close", (code: number | null) => resolve(code ?? -1));
  });
}

async function main(): Promise<void> {
  console.log("island:", await call<string>("./children.cjs", "run"));
  console.log("native exit", await nativeChild());
  console.log("island again:", await call<string>("./children.cjs", "run"));
  const sync = spawnSync("/bin/sh", ["-c", "exit 4"]);
  console.log("spawnSync status", sync.status);
  const [a, b] = await Promise.all([nativeChild(), call<string>("./children.cjs", "run")]);
  console.log("together", a, b);
}

void main();
