// The typed listener of a failed spawn receives the same errnoException
// fields, which an untyped view of the error reads.
import { spawn } from "node:child_process";

const child = spawn("/definitely/not/here", ["first", "second"]);
const seen: Error[] = [];
child.on("error", (error: Error) => {
  seen.push(error);
  console.log(error.name, error.message, error instanceof Error);
  const view: any = error;
  console.log(view.code, typeof view.errno, view.errno < 0, view.syscall, view.path);
  console.log(JSON.stringify(view.spawnargs), view.spawnargs.length);
});
child.on("error", (error: Error) => {
  console.log("same object", error === seen[0]);
});
