// --stdout-buffering: with only a child to wait for, the loop sleeps in the
// child watch. The line written before the spawn must be published before
// that sleep starts, or a reader waits for the child to exit for it.
import { spawn } from "node:child_process";

process.stdout.write("before-wait\n");
const child = spawn("/bin/sh", ["-c", "sleep 0.4"], { stdio: "ignore" });
child.on("exit", () => {
  process.stdout.write("after-wait\n");
});
