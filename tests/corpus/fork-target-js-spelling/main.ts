import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";

// The fork entry is spelled as JavaScript, and the project compiles from
// source: the build selects child.ts, the file on disk, exactly as a relative
// import of ./child.js answers child.ts. Node loads the sibling child.js,
// which sends the same message, so both lanes print the same bytes.
const child = fork(fileURLToPath(new URL("./child.js", import.meta.url)), [], {
  stdio: ["ignore", "ignore", "inherit", "ipc"],
});

child.once("message", (message: { from: string; kind: string }) => {
  console.log("reply", JSON.stringify(message));
});

child.once("exit", (code: number | null) => {
  console.log("exit", code);
});
