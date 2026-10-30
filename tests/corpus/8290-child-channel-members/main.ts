import { fork, spawn } from "node:child_process";

// `send`, `disconnect` and `channel` exist only on a child created with an
// IPC channel, and stay after the channel closes; the other members are
// on every child.
const describe = (label: string, child: ReturnType<typeof spawn>): string =>
  `${label}: send ${"send" in child} disconnect ${"disconnect" in child} channel ${"channel" in child} kill ${"kill" in child} pid ${"pid" in child}`;

const lines: string[] = [];
const plain = spawn("/bin/sh", ["-c", "exit 0"], { stdio: "ignore" });
lines.push(describe("spawn", plain));
const forked = fork(new URL("./worker.ts", import.meta.url), [], {
  stdio: ["ignore", "ignore", "inherit", "ipc"],
});
lines.push(describe("fork", forked));
forked.once("message", () => {
  forked.disconnect();
  lines.push(describe("fork after disconnect", forked));
});
forked.once("exit", () => {
  lines.push(describe("fork after exit", forked));
});
plain.once("exit", () => {
  lines.push(describe("spawn after exit", plain));
});
process.once("exit", () => {
  console.log(lines.sort().join("\n"));
});
