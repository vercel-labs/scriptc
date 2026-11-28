import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";

const child = fork(fileURLToPath(new URL("./child.js", import.meta.url)), [], {
  stdio: ["ignore", "ignore", "inherit", "ipc"],
});

child.on("exit", (code) => {
  console.log("exited", code);
});
