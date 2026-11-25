// A child_process fork that carries Node's own NODE_UNIQUE_ID worker marker:
// the child starts as a cluster worker (isWorker true, cluster.worker.id
// from the marker), and the marker is deleted from its environment, as
// Node's worker bootstrap does.
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";

const worker = fileURLToPath(new URL("./worker.cjs", import.meta.url));
const child = fork(worker, [], {
  env: { ...process.env, NODE_UNIQUE_ID: "7", ROLE: "beta" },
  stdio: ["ignore", "ignore", "inherit", "ipc"],
});
child.on("message", (message: any) => {
  console.log("parent message", JSON.stringify(message));
  child.disconnect();
});
child.on("exit", (code, signal) => console.log("parent exit", code, signal));
