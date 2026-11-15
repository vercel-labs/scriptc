// child_process.spawn's signal option: a signal aborted before the call
// still spawns the child, reports the AbortError on the next tick and kills
// it with killSignal (SIGTERM without one); a later abort kills it with
// killSignal and reports the AbortError with the abort reason as its cause;
// once the child has exited the subscription is gone and an abort is a
// no-op whose failed kill reports nothing.
import { spawn, type ChildProcess } from "node:child_process";

interface AbortErrorLike extends Error {
  code?: string;
  cause?: unknown;
}

function describe(e: unknown): string {
  const err = e as AbortErrorLike;
  const cause = err.cause;
  let shown = "none";
  if (typeof cause === "string") {
    shown = JSON.stringify(cause);
  } else if (cause instanceof Error) {
    shown = JSON.stringify(cause.message);
  }
  return [err.name, err.code ?? null, JSON.stringify(err.message), shown].join(" ");
}

function waitClose(tag: string, child: ChildProcess, next: () => void): void {
  child.on("close", (code, signal) => {
    console.log(tag, "close", code, signal);
    next();
  });
}

const sleeper = ["-c", "sleep 5"];
console.log("scheduled");

// Pre-aborted: 'spawn' then 'error', never 'close' without a kill.
{
  const controller = new AbortController();
  controller.abort("pre-reason");
  const child = spawn("/bin/sh", sleeper, { stdio: "ignore", signal: controller.signal });
  child.on("spawn", () => console.log("pre", "spawn"));
  child.on("error", (e) => console.log("pre", "error", describe(e)));
  waitClose("pre", child, () => laterAbort());
}

// A later abort with an Error reason and SIGKILL.
function laterAbort(): void {
  const controller = new AbortController();
  const child = spawn("/bin/sh", sleeper, {
    stdio: "ignore",
    signal: controller.signal,
    killSignal: "SIGKILL",
  });
  child.on("error", (e) => console.log("later", "error", describe(e)));
  setTimeout(() => {
    console.log("later", "aborting");
    controller.abort(new Error("stop now"));
  }, 80);
  waitClose("later", child, () => afterExit());
}

// Aborting after the child exited kills nothing and reports nothing.
function afterExit(): void {
  const controller = new AbortController();
  const child = spawn("/bin/sh", ["-c", "exit 2"], { stdio: "ignore", signal: controller.signal });
  child.on("error", (e) => console.log("exited", "error", describe(e)));
  waitClose("exited", child, () => {
    console.log("exited", "aborting", child.exitCode);
    controller.abort("too late");
    setTimeout(() => {
      console.log("exited", "quiet");
      neverAborted();
    }, 40);
  });
}

// A signal that is never aborted leaves the timeout in charge.
function neverAborted(): void {
  const controller = new AbortController();
  const child = spawn("/bin/sh", sleeper, {
    stdio: "ignore",
    signal: controller.signal,
    timeout: 120,
  });
  child.on("error", (e) => console.log("armed", "error", describe(e)));
  waitClose("armed", child, () => console.log("done"));
}
