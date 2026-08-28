// ChildProcess as a Map value and an array element (the mdns publisher
// registry and the running-apps list): spawn handles stored, read back,
// and iterated — REF machinery, reaped by the loop.
import { spawn } from "node:child_process";

const registry = new Map<string, ReturnType<typeof spawn>>();
const running: ReturnType<typeof spawn>[] = [];

const exited: string[] = [];
function publish(name: string): void {
  // A short-lived child (exits on its own); we register terminal handlers.
  // Two same-instant children's exit ORDER is kernel-scheduling-dependent
  // on both sides, so the observation is collected and printed sorted at
  // the barrier (the bounded-margin rule's order-independent sibling).
  // /bin/sh is present on macOS, Debian, and Alpine; the true binary itself
  // lives under different prefixes, so run the shell builtin for this
  // success-path fixture.
  const child = spawn("/bin/sh", ["-c", "true"], { stdio: "ignore" });
  registry.set(name, child);
  running.push(child);
  child.on("exit", () => {
    exited.push(name);
    if (exited.length === 2) {
      console.log("exited:", exited.slice().sort().join(","));
    }
  });
}

publish("alpha");
publish("beta");

console.log("registered:", registry.size);
console.log("has alpha:", registry.has("alpha"));
console.log("running count:", running.length);

// Read a child back out of the map (its handle survives storage).
const a = registry.get("alpha");
if (a) {
  a.on("error", () => {
    console.log("SHOULD NOT PRINT (true does not fail)");
  });
}

// Delete drops the map's reference; the loop still reaps the child.
registry.delete("beta");
console.log("after delete:", registry.size);
