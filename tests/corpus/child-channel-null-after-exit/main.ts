// A forked worker that exits with no 'message' or 'disconnect' listener:
// the channel closes with the child, so child.channel reads null and
// child.connected false from 'exit' on — including inside 'close' and
// after it.
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";

const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
const worker = fileURLToPath(new URL(`./worker.${extension}`, import.meta.url));

const child = fork(worker, [], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
console.log("before exit", typeof child.channel, child.connected);
child.once("exit", (code) => {
  console.log("exit", code, child.channel === null, child.connected);
});
child.once("close", (code) => {
  console.log("close", code, child.channel === null, child.connected);
  setImmediate(() => console.log("after close", child.channel === null, child.connected));
});
