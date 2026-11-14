// process.on and its siblings as values: `process.on.bind(process)` keeps
// the receiver, so a bound alias registers, removes and once-registers
// process listeners like a direct call. Signals arrive from an external
// child so the loop stays alive through them, 'exit' sees the final count,
// and the removed listener stays silent.
import { spawn } from "node:child_process";

const on = process.on.bind(process);
const once = process.once.bind(process);
const off = process.off.bind(process);

let interrupts = 0;
const first = (): void => {
  interrupts++;
  console.log("first SIGINT", interrupts);
};
const second = (): void => {
  interrupts++;
  console.log("second SIGINT", interrupts);
};
on("SIGINT", first);
on("SIGINT", second);
off("SIGINT", first);
once("SIGTERM", () => console.log("SIGTERM once"));
on("exit", (code: number) => console.log("exit", code, "interrupts", interrupts));

const child = spawn(
  "/bin/sh",
  [
    "-c",
    "sleep 0.2; kill -INT $PPID; sleep 0.3; kill -TERM $PPID; sleep 0.3; kill -INT $PPID; sleep 0.5",
  ],
  { stdio: "ignore" },
);
child.on("exit", (code) => {
  console.log("child exit", code ?? -1);
  setTimeout(() => {
    off("SIGINT", second);
    console.log("handlers removed");
  }, 50);
});
console.log("main done");
