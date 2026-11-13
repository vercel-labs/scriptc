// process.channel after process.disconnect(): null (the channel object is
// gone even though the process stays alive for the pending send), and a
// channel object captured earlier keeps answering ref/unref as no-ops.
import { fork } from "node:child_process";

const child = fork(new URL("./worker.ts", import.meta.url), [], {
  stdio: ["ignore", "inherit", "inherit", "ipc"],
});
child.on("message", (message: { kind: string }) => console.log("parent got", JSON.stringify(message)));
child.on("exit", (code) => console.log("child exit", code));
child.send({ kind: "disconnect please" });
