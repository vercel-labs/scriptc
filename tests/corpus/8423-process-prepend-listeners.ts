// process.prependListener registers the listener at the FRONT of an
// event's listener list (Node's EventEmitter order) for the registries
// that own a prepend entry: 'exit' and the signal family. on/once keep
// appending, so a prepend registered between them still dispatches first.
import { spawn } from "node:child_process";

process.on("exit", (code) => console.log(`exit on 1 (${code})`));
process.prependListener("exit", (code) => console.log(`exit prepend 0 (${code})`));
process.once("exit", (code) => console.log(`exit once 2 (${code})`));
process.prependListener("exit", () => console.log("exit prepend last-registered, still first"));

let ints = 0;
const onInt = () => {
  ints++;
  console.log("SIGINT on", ints);
};
process.on("SIGINT", onInt);
process.prependListener("SIGINT", () => console.log("SIGINT prepend", ints));

const child = spawn("/bin/sh", ["-c", "sleep 0.2; kill -INT $PPID; sleep 0.2"], { stdio: "ignore" });
child.on("exit", (code) => {
  console.log("child exit", code ?? -1, "ints", ints);
});
console.log("main done");
