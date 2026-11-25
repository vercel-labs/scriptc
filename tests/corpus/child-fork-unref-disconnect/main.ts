import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";

// Node's Control drops the IPC handle from the loop's keep-alive set when
// the channel closes, so unref() plus disconnect() lets the parent exit
// while the child still runs. A runtime that keeps the channel referenced
// stays alive to the timer below and prints its line.
const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
const worker = fileURLToPath(new URL(`./worker.${extension}`, import.meta.url));

const child = fork(worker, [], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
child.once("spawn", () => {
  child.unref();
  child.disconnect();
  console.log("parent exiting");
});
child.once("disconnect", () => console.log("disconnect"));
// Unref'd, so it fires only if something else (the leaked channel) keeps
// the loop alive; exiting from it bounds the failing run.
setTimeout(() => {
  console.log("still alive");
  process.exit(3);
}, 1000).unref();
