// subprocess.channel: undefined without an IPC channel, the fork's Control
// object otherwise (stable identity, ref()/unref() answer undefined and move
// only the channel's keep-alive state), and null once the channel
// disconnects or the child exits.
import { fork, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
const worker = fileURLToPath(new URL(`./worker.${extension}`, import.meta.url));

function closed(child: ReturnType<typeof fork>): Promise<number | null> {
  return new Promise((resolve) => child.once("close", (code) => resolve(code)));
}

const plain = spawn("echo", ["hi"]);
console.log("spawn", typeof plain.channel, plain.channel === undefined);
console.log("spawn optional", plain.channel?.ref() === undefined);
console.log("spawn close", await closed(plain));
console.log("spawn closed", typeof plain.channel, plain.channel === undefined);

const child = fork(worker, [], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
const channel = child.channel;
console.log("fork", typeof channel, channel === child.channel, channel === null);
console.log("fork connected", child.connected);
if (channel) {
  console.log("ref", channel.ref() === undefined);
  console.log("unref", channel.unref() === undefined);
  console.log("ref again", channel.ref() === undefined);
}
child.once("message", (message: { ack: boolean }) => console.log("message", message.ack));
child.once("disconnect", () =>
  console.log("disconnect", child.connected, child.channel === null));
child.send({ go: true });
console.log("fork close", await closed(child), child.channel === null);

const second = fork(worker, [], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
console.log("second", typeof second.channel, second.channel === null);
second.once("message", (message: { ack: boolean }) => {
  console.log("second message", message.ack);
  second.disconnect();
  console.log("second disconnected", second.connected, second.channel === null);
});
second.send({ go: true });
console.log(
  "second exit",
  await new Promise((resolve) => second.once("exit", (code) => resolve(code))),
);
console.log("second channel", second.channel === null, second.channel === undefined);
