// An explicit channel.ref() overrides the listener-driven ref state: the
// worker unrefs the channel at start, refs it again from a timer (so the
// process stays alive while the channel is open), reports, and disconnects.
// The message is buffered and printed when the child exits: both processes
// write to the same inherited stdout, so printing from the message handler
// would interleave with the child's own line at a timing the program cannot
// control.
import { fork } from "node:child_process";

const child = fork(new URL("./worker.ts", import.meta.url), [], {
  stdio: ["ignore", "inherit", "inherit", "ipc"],
});
let received: string | null = null;
child.on("message", (message: { kind: string }) => {
  received = JSON.stringify(message);
});
child.on("exit", (code) => {
  console.log("parent got", received);
  console.log("child exit", code);
});
