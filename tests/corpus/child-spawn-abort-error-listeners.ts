// child_process: an aborted spawn's 'error' emit hands every listener that
// was registered when the emit began its call, even when one unregisters
// itself or a sibling from inside the emit; a listener added during the
// emit waits for the next one.
import { spawn } from "node:child_process";

const controller = new AbortController();
const child = spawn("/bin/sh", ["-c", "sleep 5"], {
  stdio: "ignore",
  signal: controller.signal,
});
const note = "capture-alive";
const second = function (error: Error): void {
  console.log("second", (error as { code?: string }).code, note);
};
child.on("error", function self(error: Error): void {
  console.log("first", (error as { code?: string }).code, note);
  child.off("error", second);
  child.off("error", self);
  child.on("error", () => console.log("late"));
  console.log("first after off", note);
});
child.on("error", second);
child.on("close", (code, signal) => console.log("close", code, signal));
console.log("scheduled");
setTimeout(() => {
  console.log("aborting");
  controller.abort();
}, 40);
