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
// The parent and the child share the inherited stdout, so a line printed from
// a channel handler races the child's own send-callback lines. The handler
// lines are buffered and printed when the child exits, after its last write;
// which lines print, and their order, is unchanged.
const pending: string[] = [];
child.once("message", (message: { connected: boolean; echo: string }) => {
  pending.push(`reply ${message.echo} ${message.connected}`);
});
child.once("disconnect", () => {
  pending.push(`parent disconnect ${child.connected}`);
});
child.once("exit", (code) => {
  for (const line of pending) console.log(line);
  console.log("parent exit", code);
});
console.log("send", child.send({ kind: "ping" }));
