// A forked child's IPC channel: process.channel is the channel object while
// connected. The worker reports its shape, unrefs the channel so the child
// can exit with nothing else ref'd, and sends once more before it goes.
import { fork } from "node:child_process";

const child = fork(new URL("./worker.ts", import.meta.url), [], {
  stdio: ["ignore", "inherit", "inherit", "ipc"],
});
child.on("message", (message: { kind: string }) => console.log("parent got", JSON.stringify(message)));
child.on("exit", (code) => console.log("child exit", code));
