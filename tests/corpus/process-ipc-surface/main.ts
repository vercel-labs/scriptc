// process.send/process.connected/process.disconnect and the 'message' and
// 'disconnect' events across a forked IPC child: the parent's channel is
// connected on spawn, a send answers true, the child's reply carries its
// own connected state, and the child's disconnect clears connected on both
// sides before the child exits.
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";

const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
const childPath = fileURLToPath(new URL(`./child.${extension}`, import.meta.url));
const child = fork(childPath, [], {
  execArgv: [],
  stdio: ["ignore", "inherit", "inherit", "ipc"],
});

console.log("parent connected", child.connected);
child.once("message", (message: { connected: boolean; echo: string }) => {
  console.log("reply", message.echo, message.connected);
});
child.once("disconnect", () => {
  console.log("parent disconnect", child.connected);
});
child.once("exit", (code) => console.log("parent exit", code));
console.log("send", child.send({ kind: "ping" }));
