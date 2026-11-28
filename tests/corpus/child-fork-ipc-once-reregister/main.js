import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";

const child = fork(fileURLToPath(new URL("./child.js", import.meta.url)), [], {
  stdio: ["ignore", "ignore", "inherit", "ipc"],
});

const replies = [];
child.on("message", (message) => {
  replies.push(message.kind);
});
child.send({ type: "go" });
child.send({ type: "go" });
child.on("exit", (code) => {
  console.log(replies.join(","), code);
});
