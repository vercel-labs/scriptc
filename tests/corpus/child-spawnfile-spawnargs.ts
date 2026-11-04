// ChildProcess.spawnfile and spawnargs report what the runtime started: the
// file and the argument vector Node passed to the OS. A direct spawn reports
// the command and its arguments; the shell forms (exec, and spawn with
// shell: true) report the shell and its invocation; a spawn failure still
// reports the file and arguments it attempted.
import { exec, spawn } from "node:child_process";

const direct = spawn("echo", ["hi"], { stdio: "ignore" });
console.log("direct file", direct.spawnfile);
console.log("direct args", JSON.stringify(direct.spawnargs));

const shell = spawn("echo shell-line", [], { shell: true, stdio: "ignore" });
console.log("shell file", shell.spawnfile);
console.log("shell args", JSON.stringify(shell.spawnargs));
console.log("shell length", shell.spawnargs.length);

const execChild = exec("echo hi", () => {});
console.log("exec file", execChild.spawnfile);
console.log("exec args", JSON.stringify(execChild.spawnargs));
console.log("exec length", execChild.spawnargs.length);

const failed = spawn("definitely-not-a-binary-xyz", ["a", "b"], { stdio: "ignore" });
console.log("failed file", failed.spawnfile);
console.log("failed args", failed.spawnargs.join(" "));
failed.on("error", () => {
  console.log("failed file after error", failed.spawnfile);
  console.log("failed arg count", failed.spawnargs.length);
});

// The array is a real Array value: iteration, indexing, and length work.
for (const arg of direct.spawnargs) console.log("iter", arg);
console.log("index", direct.spawnargs[1], "length", direct.spawnargs.length);
