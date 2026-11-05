// Node evaluates a stdio array's slots in order: an stdout fd expression
// runs before a later stderr mode expression. The lowering binds each
// slot's value in source order, so the trace matches Node's.
import { spawn } from "node:child_process";

const trace: string[] = [];
function stdoutFd(): number {
  trace.push("stdout-fd");
  return 1;
}
function stderrMode(): "ignore" | "inherit" {
  trace.push("stderr-mode");
  return "ignore";
}

const child = spawn("/bin/true", { stdio: ["pipe", stdoutFd(), stderrMode()] });
child.on("exit", (code) => {
  console.log("order", trace.join(","), code);
});
