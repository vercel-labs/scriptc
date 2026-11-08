// A synchronous capture's timeout returns at the deadline even when a
// grandchild still holds the pipes: Node kills the child and closes its
// ends of the stdio pipes, so nothing is left to wait for. The shell here
// is killed while the `sleep` it started keeps stdout open for 20 s.
import { execFileSync, execSync, spawnSync } from "node:child_process";

function code(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return String((error as NodeJS.ErrnoException).code);
  }
  return "no error";
}

let started = Date.now();
const result = spawnSync("/bin/sh", ["-c", "echo started; sleep 20"], { encoding: "utf8", timeout: 300 });
console.log("spawnSync:", result.status, result.signal, JSON.stringify(result.stdout));
console.log("spawnSync returned at the deadline:", Date.now() - started < 10000);

started = Date.now();
console.log("execSync:", code(() => execSync("echo started; sleep 20", { timeout: 300, stdio: "pipe" })));
console.log("execSync returned at the deadline:", Date.now() - started < 10000);

started = Date.now();
console.log("execFileSync:", code(() => execFileSync("/bin/sh", ["-c", "sleep 20"], { timeout: 300 })));
console.log("execFileSync returned at the deadline:", Date.now() - started < 10000);

// With cwd, the extended spawn core.
started = Date.now();
const inDir = spawnSync("/bin/sh", ["-c", "echo started; sleep 20"], {
  encoding: "utf8",
  timeout: 300,
  cwd: process.cwd(),
});
console.log("spawnSync cwd:", inDir.status, inDir.signal, JSON.stringify(inDir.stdout));
console.log("spawnSync cwd returned at the deadline:", Date.now() - started < 10000);
