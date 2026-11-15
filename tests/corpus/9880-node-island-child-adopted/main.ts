// @requires-libnode
// A child process started by code in a Node island and used natively at the type node:child_process
// declares. It arrives untyped and is bound to a ChildProcess: the native child stands for the
// island's process, so its output, its stdin and its events are the island child's.
import type { ChildProcess } from "node:child_process";
import { requireModule } from "@scriptc/node";

const lib = requireModule("./lib.cjs");

function finished(child: ChildProcess): Promise<string> {
  return new Promise((resolve) => {
    let out = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString();
    });
    child.on("error", (error) => resolve(`error:${error.message}`));
    child.on("close", (code) => resolve(`${out.trim()} close:${code}`));
  });
}

async function main(): Promise<void> {
  for (const script of ["echo hello", "cat"]) {
    try {
      const child: ChildProcess = lib.start("sh", ["-c", script]);
      if (script === "cat") child.stdin?.end("from the parent\n");
      console.log(script, "->", await finished(child));
    } catch (error) {
      console.log(script, "-> failed:", (error as Error).message);
    }
  }
  // The same through an assertion.
  const asserted = lib.start("sh", ["-c", "echo asserted; exit 4"]) as ChildProcess;
  console.log("asserted ->", await finished(asserted), "exitCode", asserted.exitCode, typeof asserted.pid);
}
main();
