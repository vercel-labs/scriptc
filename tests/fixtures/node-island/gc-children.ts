// Child processes a Node island starts, each used natively through a typed ChildProcess whose
// listeners capture it, then dropped. node-island-gc.test.ts runs this for two iteration counts
// and compares what stays alive: nothing may grow with the number of children that came and went.
import type { ChildProcess } from "node:child_process";
import { requireModule } from "@scriptc/node";

const lib = requireModule("./gc-children.cjs");
const total = Number(process.argv[2] ?? "200");
let bytes = 0;
let closed = 0;
let codes = 0;

function one(i: number): Promise<void> {
  return new Promise((resolve) => {
    const child: ChildProcess = lib.start(`echo ${i}; exit ${i % 3}`);
    // Each listener holds the child it is registered on: a cycle through both heaps.
    child.stdout?.on("data", (chunk: Buffer) => {
      bytes += chunk.length + (child.killed ? 1 : 0);
    });
    child.on("exit", (code) => {
      codes += (code ?? 0) + (child.exitCode ?? 0);
    });
    child.on("close", () => {
      closed += child.killed ? 0 : 1;
      resolve();
    });
  });
}

async function main(): Promise<void> {
  for (let done = 0; done < total; done += 20) {
    const batch: Promise<void>[] = [];
    for (let i = done; i < Math.min(total, done + 20); i++) batch.push(one(i));
    await Promise.all(batch);
  }
  // One child the program keeps, which must stay usable.
  const kept: ChildProcess = lib.start("cat");
  await new Promise<void>((resolve) => setTimeout(resolve, 10));
  kept.stdin?.end();
  await new Promise<void>((resolve) => kept.on("close", () => resolve()));
  // Full collections with turns between them: Node lets go of a child a few turns after its
  // 'close', a collection then frees the island's child object with its listener functions, and
  // the next one what those held.
  for (let pass = 0; pass < 3; pass++) {
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    lib.collect();
  }
  await new Promise<void>((resolve) => setTimeout(resolve, 10));
  console.log("closed", closed, "bytes", bytes, "codes", codes, "kept", kept.exitCode);
}
main();
