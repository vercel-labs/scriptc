// process.cwd's function value is "wrappedCwd" on the main thread and ""
// inside a Worker, where Node hands out the unwrapped function. The name is
// the same through the global, the module, named/default/namespace imports,
// const and destructured aliases and a saved member, and the function still
// reads the directory it is called from in both threads.
import { Worker, isMainThread, parentPort } from "node:worker_threads";
import processDefault from "node:process";
import * as processModule from "node:process";
import { cwd as namedCwd } from "node:process";

const constAlias = process.cwd;
const { cwd: destructured } = process;
const { cwd: fromModule } = processModule;
const holder = { read: process.cwd };
const calls = [constAlias, namedCwd, holder.read];
const rows = [
  ["global", process.cwd.name],
  ["named", namedCwd.name],
  ["namespace", processModule.cwd.name],
  ["default", processDefault.cwd.name],
  ["const", constAlias.name],
  ["destructured", destructured.name],
  ["module-destructured", fromModule.name],
  ["member", holder.read.name],
  ["length", String(process.cwd.length)],
  ["same", String(calls.every((f) => f === process.cwd))],
  ["calls", String(calls.every((f) => f() === process.cwd()))],
];

if (isMainThread) {
  for (const [label, value] of rows) console.log("main", label, value);
  const worker = new Worker(new URL(import.meta.url));
  worker.on("message", (received) => {
    for (const [label, value] of received) console.log("worker", label, value);
  });
} else {
  parentPort.postMessage(rows);
}
