// child.on() and child.once() return the child, so registrations chain
// and the result can be stored or passed on. The receiver evaluates once,
// before the listener. Each child starts after the previous one closed.
import { spawn } from "node:child_process";

const events: string[] = [];
let lookups = 0;
const children = [spawn("sh", ["-c", "exit 3"], { stdio: "ignore" })];
function first() {
  lookups++;
  return children[0]!;
}

const returned = first()
  .on("exit", (code) => events.push(`exit ${code}`))
  .once("close", (code, signal) => {
    events.push(`close ${code} ${signal}`);
    console.log(events.join(", "), lookups);
    second();
  })
  .on("error", (err) => events.push(`error ${err.message}`));
console.log(returned === children[0], lookups);

function second(): void {
  spawn("sh", ["-c", "exit 0"], { stdio: "ignore" })
    .on("spawn", () => console.log("spawned"))
    .on("exit", (code) => console.log("second exit", code))
    .on("close", () => third());
}

function third(): void {
  const missing = spawn("/nonexistent/command-for-test", [], { stdio: "ignore" }).on(
    "error",
    (e) => console.log("missing", (e as NodeJS.ErrnoException).code),
  );
  console.log(typeof missing.pid);
  const detached = spawn("sh", ["-c", "exit 0"], { detached: true, stdio: "ignore" }).once(
    "error",
    (e) => console.log("spawn failed", e.message),
  );
  detached.unref();
}
