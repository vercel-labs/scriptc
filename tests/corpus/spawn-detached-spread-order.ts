// The conditional spread is one of the options object's members, so its
// condition runs where the spread sits: before a stdio expression that
// follows it. The lowering binds the spread's condition at that position in
// the call's prelude.
import { spawn } from "node:child_process";

const trace: string[] = [];
function detachedCondition(): boolean {
  trace.push("detached");
  return true;
}
function stdioValue(): "pipe" | "ignore" {
  trace.push("stdio");
  return "ignore";
}

const child = spawn("/bin/true", {
  ...(detachedCondition() ? { detached: true } : {}),
  stdio: stdioValue(),
});
child.on("exit", (code) => {
  console.log("order", trace.join(","), code);
});
