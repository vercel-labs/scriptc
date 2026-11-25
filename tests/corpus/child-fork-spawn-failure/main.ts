// A fork's stdio array is built from the slots the launch configured, so a
// fork whose spawn fails still answers four entries (the IPC slot is null),
// not three. The launch fails through a missing cwd, which needs no
// platform-specific executable path.
import { fork } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
const worker = fileURLToPath(new URL(`./worker.${extension}`, import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "scriptc-fork-failure-"));
const child = fork(worker, [], {
  cwd: join(dir, "missing"),
  stdio: ["ignore", "ignore", "inherit", "ipc"],
});
const stdio = child.stdio;
console.log("length", stdio.length, "stable", stdio === child.stdio);
console.log(
  "slots",
  stdio[0] === child.stdin,
  stdio[1] === child.stdout,
  stdio[2] === child.stderr,
);
console.log("nulls", stdio[0] === null, stdio[1] === null, stdio[2] === null, stdio[3] === null);
child.on("error", (error) => console.log("error", (error as NodeJS.ErrnoException).code));
child.on("close", (code, signal) => {
  console.log("close", code, signal);
  rmSync(dir, { recursive: true, force: true });
});
