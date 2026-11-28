import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";

// The child sends records whose members are unknown-typed, and a record that
// declares toJSON. Node serializes both with JSON.stringify inside send: the
// unknown members keep their JSON values, an undefined-valued member drops,
// and toJSON decides the record. Both lanes print the same bytes.
const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
const child = fork(fileURLToPath(new URL(`./worker.${extension}`, import.meta.url)), [], {
  stdio: ["ignore", "ignore", "inherit", "ipc"],
});

child.on("message", (message: unknown) => {
  console.log("reply", JSON.stringify(message));
});

child.once("exit", (code: number | null) => {
  console.log("exit", code);
});
