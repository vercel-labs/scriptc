// A saved Control's ref() after the channel disconnects must not put it back
// in the loop's keep-alive set: Node drops the pipe handle when the channel
// closes, so ref() and unref() are no-ops from then on. The parent therefore
// exits once this handler returns, without waiting for the worker it unref'd,
// and its 'exit' listener never runs.
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";

const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
const worker = fileURLToPath(new URL(`./worker.${extension}`, import.meta.url));

const child = fork(worker, [], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
const channel = child.channel;
child.on("message", (message) => {
  console.log("message", message);
  child.unref();
  child.disconnect();
});
child.on("disconnect", () => {
  console.log("disconnect", child.connected);
  channel?.ref();
});
child.on("exit", (code) => console.log("exit", code));
