// @no-node-shims
// fork checks its arguments, cwd and environment like the other launches:
// a NUL in any of them throws ERR_INVALID_ARG_VALUE from the call, before a
// worker starts. Node names an argument by its place in the list it spawns:
// its own exec arguments, the module path, then the arguments, so with no
// exec arguments (this program runs without the harness's --import, which
// would count) the first argument is args[1].
import { fork } from "node:child_process";

const worker = new URL("./worker.ts", import.meta.url);

function check(label: string, start: () => unknown): void {
  try {
    start();
    console.log(label, "returned");
  } catch (error) {
    const e = error as NodeJS.ErrnoException;
    console.log(label, "threw", e.name, e.code, JSON.stringify(e.message));
  }
}

check("argument", () => fork(worker, ["a\u0000b"]));
check("second argument", () => fork(worker, ["first", "a\u0000b"]));
check("cwd", () => fork(worker, ["cwd"], { cwd: "/tmp\u0000/x" }));
check("env value", () => fork(worker, ["env"], { env: { ...process.env, A: "x\u0000y" } }));
check("argument before cwd", () => fork(worker, ["a\u0000b"], { cwd: "/tmp\u0000/x" }));

const child = fork(worker, ["plain", "arguments"]);
child.once("message", (message) => {
  console.log("worker said", JSON.stringify(message));
});
