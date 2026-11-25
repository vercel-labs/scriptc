// ChildProcess[Symbol.dispose](): Node's dispose sends SIGTERM only while
// `killed` is false and answers undefined. `using` and `await using` call
// it at scope exit, a child that already took a signal is left alone, an
// exited child keeps `killed` false, and a spawn failure makes it a
// no-op. The signal-0 send marks `killed` without ending the child, so a
// dispose after it sends nothing.
import { fork, spawn } from "node:child_process";

function closed(child: ReturnType<typeof spawn>): Promise<number | null> {
  return new Promise((resolve) => child.once("close", (code) => resolve(code)));
}

// Explicit dispose on a live child.
const running = spawn("sleep", ["5"], { stdio: "ignore" });
console.log("running killed before", running.killed);
running[Symbol.dispose]();
console.log("dispose returns undefined; killed after", running.killed);
running[Symbol.dispose]();
console.log("dispose again leaves killed", running.killed);
running.once("exit", (code, signal) => {
  console.log("running exit", code, signal, running.exitCode, running.signalCode);
});
console.log("running close", await closed(running));

// Signal 0 marks `killed` while the child keeps running; dispose then
// sends nothing and the child is ended by an explicit kill.
const probed = spawn("sleep", ["5"], { stdio: "ignore" });
console.log("probe kill 0", probed.kill(0), probed.killed);
probed[Symbol.dispose]();
console.log("probe dispose leaves killed", probed.killed);
console.log("probe kill", probed.kill("SIGKILL"), probed.killed);
probed.once("exit", (code, signal) => console.log("probe exit", code, signal));
console.log("probe close", await closed(probed));

// An explicit kill already set `killed`: dispose does not send again.
const killed = spawn("sleep", ["5"], { stdio: "ignore" });
console.log("killed kill", killed.kill("SIGKILL"), killed.killed);
killed[Symbol.dispose]();
console.log("killed dispose leaves killed", killed.killed);
killed.once("exit", (code, signal) => console.log("killed exit", code, signal));
console.log("killed close", await closed(killed));

// A child that ran to completion: `killed` stays false, dispose is a
// no-op and still answers undefined.
const finished = spawn("true", [], { stdio: "ignore" });
await closed(finished);
console.log("finished", finished.killed, finished.exitCode, finished.signalCode);
finished[Symbol.dispose]();
console.log("finished dispose leaves killed", finished.killed);

// A spawn failure: pid undefined, dispose is a no-op.
const missing = spawn("/definitely/not/here", [], { stdio: "ignore" });
missing.on("error", (error) => console.log("missing error", (error as Error & { code?: string }).code));
await closed(missing);
console.log("missing", missing.pid === undefined, missing.killed, missing.exitCode);
missing[Symbol.dispose]();
console.log("missing dispose leaves killed", missing.killed);

// using: the scope exit disposes a child that is still running.
const usingClosed = new Promise<void>((resolve) => {
  const scopeClosed = resolve;
  {
    using scoped = spawn("sleep", ["5"], { stdio: "ignore" });
    console.log("using spawned", (scoped.pid ?? 0) > 0);
    scoped.once("exit", (code, signal) => console.log("using exit", code, signal));
    scoped.once("close", (code, signal) => {
      console.log("using close", code, signal);
      scopeClosed();
    });
  }
  console.log("after using block");
});
await usingClosed;

// await using: ChildProcess has only the synchronous dispose, which the
// awaited form calls.
let awaitedDone!: () => void;
const awaitedClosed = new Promise<void>((resolve) => {
  awaitedDone = resolve;
});
async function awaitedScope(): Promise<void> {
  await using awaited = spawn("sleep", ["5"], { stdio: "ignore" });
  awaited.once("close", (code, signal) => {
    console.log("awaited close", code, signal);
    awaitedDone();
  });
}
const awaitedRun = awaitedScope();
console.log("after await using block");
await awaitedClosed;
await awaitedRun;

// A forked child's dispose ends the child the same way.
const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
const worker = new URL(`./worker.${extension}`, import.meta.url);
const forked = fork(worker, [], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
forked.once("close", (code, signal) => console.log("fork close", code, signal));
forked[Symbol.dispose]();
console.log("fork killed", forked.killed, forked.connected);
