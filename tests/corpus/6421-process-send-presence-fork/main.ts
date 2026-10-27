// process.send and process.disconnect exist in a forked child (an IPC
// channel) and not in the parent; the child's presence checks pick the
// channel and its guarded send reaches the parent.
import { fork } from "node:child_process";

console.log("parent", Boolean(process.send), typeof process.send, typeof process.disconnect);
const child = fork(new URL("./worker.ts", import.meta.url), [], {
  stdio: ["ignore", "inherit", "inherit", "ipc"],
});
child.on("message", (message: { sink: string; send: string; disconnect: string }) => {
  console.log("child says", message.sink, message.send, message.disconnect);
});
child.on("exit", (code) => console.log("child exit", code));
