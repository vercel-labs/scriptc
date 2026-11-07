// The ChildProcess handle spawn() returns: pid, the 'spawn', 'exit' and
// 'close' events with exitCode and signalCode, kill() with the killed flag
// and the signal the child died from, ref()/unref() on a detached child,
// and the 'error' event for a command that does not exist.
import { spawn } from "node:child_process";

function exited(child: ReturnType<typeof spawn>): Promise<void> {
  return new Promise((resolve) => {
    child.on("close", () => resolve());
  });
}

// A child that runs to completion.
const echo = spawn("echo", ["hi"]);
console.log(typeof echo.pid, (echo.pid ?? 0) > 0, echo.killed, echo.exitCode, echo.signalCode);
echo.on("spawn", () => console.log("spawn"));
echo.stdout?.on("data", (data) => console.log("out", data.toString().trim()));
echo.on("exit", (code, signal) => console.log("exit", code, signal, echo.exitCode, echo.signalCode));
echo.on("close", (code, signal) => console.log("close", code, signal));
await exited(echo);

// A child killed by a signal.
const sleeper = spawn("sleep", ["5"]);
sleeper.on("exit", (code, signal) =>
  console.log("exit", code, signal, sleeper.killed, sleeper.exitCode, sleeper.signalCode),
);
console.log(sleeper.kill("SIGTERM"), sleeper.killed);
await exited(sleeper);

// A detached child, unreferenced and referenced again.
const detached = spawn("sleep", ["0.05"], { detached: true, stdio: "ignore" });
detached.unref();
detached.ref();
detached.on("exit", (code) => console.log("detached exit", code));
await exited(detached);

// A command that cannot be spawned reports 'error', then 'close'.
const missing = spawn("/definitely/not/here");
missing.on("error", (error) => {
  const err = error as Error & { code?: string };
  console.log("error", err.code, err instanceof Error, typeof missing.pid);
});
await exited(missing);
console.log("done");
