// @requires-libnode
// A spawn that fails in a Node island, seen natively: 'error' with the island's error (its name,
// message and code; the same object for every listener), no 'exit', then 'close' with the negative
// errno, and pid undefined.
import type { ChildProcess } from "node:child_process";
import { requireModule } from "@scriptc/node";

const lib = requireModule("./lib.cjs");

function watch(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    const log: string[] = [];
    let first: Error | undefined;
    child.on("spawn", () => log.push("spawn"));
    child.on("error", (error) => {
      first = error;
      const e = error as NodeJS.ErrnoException;
      log.push(`error ${e.name} ${e.message} instanceof Error ${error instanceof Error} code=${e.code}`);
    });
    child.on("error", (error) => log.push(`second listener, same error: ${error === first}`));
    child.on("exit", (code, signal) => log.push(`exit:${code}:${signal}`));
    child.on("close", (code, signal) => {
      log.push(`close:${code}:${signal} exitCode=${child.exitCode} pid=${child.pid} killed=${child.killed}`);
      for (const line of log) console.log(line);
      console.log("kill ->", child.kill());
      resolve();
    });
  });
}

async function main(): Promise<void> {
  const child: ChildProcess = lib.start("/nonexistent/scriptc-island-child", ["a", "b"]);
  console.log("pid before the event", child.pid, "exitCode", child.exitCode);
  await watch(child);
  // The streams of a failed spawn exist and end without data.
  const again: ChildProcess = lib.start("/nonexistent/scriptc-island-child-2", []);
  let ended = 0;
  again.stdout?.on("data", () => console.log("unexpected data"));
  again.stdout?.on("end", () => ended++);
  again.on("error", (error: NodeJS.ErrnoException) => console.log("again:", error.code));
  await new Promise<void>((resolve) => again.on("close", () => resolve()));
  console.log("stdout ended", ended);
}
main();
