import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";

const child = fork(fileURLToPath(new URL("./child.js", import.meta.url)), [], {
  stdio: ["ignore", "inherit", "inherit", "ipc"],
});

let decided = false;
child.on("exit", (code) => {
  if (decided) return;
  decided = true;
  console.log("exited", code);
});
setTimeout(() => {
  if (decided) return;
  decided = true;
  console.log("alive");
  child.kill();
}, 200);
