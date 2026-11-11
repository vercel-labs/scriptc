// An explicit channel.ref() overrides the listener-driven ref state: the
// worker unrefs the channel at start, refs it again from a timer (so the
// process stays alive while the channel is open), reports, and disconnects.
import { fork } from "node:child_process";

const child = fork(new URL("./worker.ts", import.meta.url), [], {
  stdio: ["ignore", "inherit", "inherit", "ipc"],
});
child.on("message", (message: { kind: string }) => console.log("parent got", JSON.stringify(message)));
child.on("exit", (code) => console.log("child exit", code));
