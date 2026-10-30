// A child spawned from a 'close' listener that exits before the listener
// returns still emits 'spawn' before 'exit'.
import { spawn } from "node:child_process";

function busyWait(ms: number): void {
  const end = Date.now() + ms;
  while (Date.now() < end) {}
}

const events: string[] = [];
spawn("sh", ["-c", "exit 0"], { stdio: "ignore" }).on("close", () => {
  const child = spawn("sh", ["-c", "exit 4"], { stdio: "ignore" });
  child.on("spawn", () => events.push("spawn"));
  child.on("exit", (code) => events.push(`exit ${code}`));
  child.on("close", (code) => {
    events.push(`close ${code}`);
    console.log(events.join(", "));
  });
  busyWait(300);
});
