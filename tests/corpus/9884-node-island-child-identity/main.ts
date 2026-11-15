// @requires-libnode
// Identity of a child process a Node island started. The same island process is the same native
// child each time it crosses, the native child handed back is the island's own object, listeners
// are the island emitter's (their order with the island's own, removal by function).
import type { ChildProcess } from "node:child_process";
import { requireModule } from "@scriptc/node";

const lib = requireModule("./lib.cjs");

async function main(): Promise<void> {
  const raw: unknown = lib.start("cat");
  const a = raw as ChildProcess;
  const b: ChildProcess = lib.kept();
  console.log("crossing twice, same native child:", a === b);
  const back: unknown = a;
  console.log("handed back, the island's object:", lib.isKept(back), lib.isChild(back), back === raw);
  const held: ChildProcess[] = [a];
  console.log("found in an array of them:", held.includes(b), held.indexOf(b));
  console.log("streams are one object:", a.stdout === b.stdout, a.stdin === b.stdin, a.stdout === a.stderr);

  // Listeners are the island emitter's: the island counts them, and they run in registration
  // order with the island's own.
  const order: string[] = [];
  const first = (): void => {
    order.push("native first");
  };
  const removed = (): void => {
    order.push("removed (must not run)");
  };
  a.on("exit", first);
  lib.onExit(raw, () => order.push("island"));
  a.on("exit", removed);
  b.on("exit", () => order.push("native last"));
  console.log("exit listeners the island sees:", lib.count(raw, "exit"));
  b.off("exit", removed);
  a.removeListener("exit", removed);
  console.log("after removal:", lib.count(raw, "exit"));
  a.on("close", (code) => {
    console.log("order:", order.join(", "), "close", code);
  });
  a.stdin?.end();
  await new Promise<void>((resolve) => b.on("close", () => resolve()));
}
main();
