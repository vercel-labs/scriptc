// process.channel.unref() only drops the IPC channel from the loop's
// keep-alive set: the channel keeps reading, so the parent's message still
// arrives while a referenced timer holds the child's loop open. Printing
// from the parent's own stdout keeps the two processes' lines from
// interleaving.
import { fork } from "node:child_process";

const child = fork(new URL("./worker.ts", import.meta.url), [], {
  stdio: ["ignore", "inherit", "inherit", "ipc"],
});
child.send({ kind: "hello" });
child.on("exit", (code) => console.log("child exit", code));
