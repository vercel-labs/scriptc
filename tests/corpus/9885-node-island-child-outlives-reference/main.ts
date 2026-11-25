// @requires-libnode
// A child process that outlives the program's reference to it. The native child is dropped as soon
// as its listeners are attached; the process keeps running, its output and its events still arrive,
// and a listener that captures the child keeps working with it.
import type { ChildProcess } from "node:child_process";
import { requireModule } from "@scriptc/node";

const lib = requireModule("./lib.cjs");
const lines: string[] = [];

function attach(name: string, script: string): Promise<void> {
  return new Promise((resolve) => {
    const child: ChildProcess = lib.start(script);
    child.stdout?.on("data", (chunk: Buffer) => lines.push(`${name} out ${chunk.toString().trim()}`));
    child.on("exit", (code) => lines.push(`${name} exit ${code}`));
    child.on("close", (code) => {
      lines.push(`${name} close ${code}`);
      resolve();
    });
  });
}

function attachCapturing(script: string): Promise<void> {
  return new Promise((resolve) => {
    const child: ChildProcess = lib.start(script);
    // The listeners hold the child they belong to.
    child.stdout?.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes("ready")) child.stdin?.write("go\n");
      else lines.push(`capturing out ${chunk.toString().trim()} (exitCode ${child.exitCode})`);
    });
    child.on("close", (code) => {
      lines.push(`capturing close ${code} exitCode ${child.exitCode} killed ${child.killed}`);
      resolve();
    });
  });
}

async function main(): Promise<void> {
  const slow = attach("slow", "sleep 0.2; echo late");
  const fast = attach("fast", "echo early");
  await fast;
  // Nothing native names either child now; collect on both sides while the slow one still runs.
  lib.collect();
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
  lib.collect();
  await slow;
  await attachCapturing("echo ready; read line; echo got $line");
  for (const line of lines.sort()) console.log(line);
}
main();
