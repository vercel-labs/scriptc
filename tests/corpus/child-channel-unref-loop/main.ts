// child.channel.unref() takes the channel's reader out of the loop's
// keep-alive set, as Node's Control unrefs the pipe handle: after it and
// child.unref(), a pending timer lets the process exit even though the
// worker is still running and its late message is never delivered.
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";

const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
const worker = fileURLToPath(new URL(`./worker.${extension}`, import.meta.url));

const child = fork(worker, [], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
child.on("message", (message) => console.log("message", message));
const channel = child.channel;
console.log("channel", typeof channel, channel === child.channel);
if (channel) channel.unref();
child.unref();
setTimeout(() => console.log("timer"), 300);
