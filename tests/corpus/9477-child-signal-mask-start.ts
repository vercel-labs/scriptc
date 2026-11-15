// A child process starts with an empty signal mask, whatever mask the
// program itself was started with: a signal the program inherited as blocked
// is delivered to its children, so they can be ended by it and the left side
// of a shell pipeline still ends by SIGPIPE.
//
// The program runs itself again through perl, whose POSIX module blocks the
// signals first (the mask survives an exec; a shell has no way to block a
// signal). Every child is a shell that sends the signal to itself:
// "survived" would mean the child had inherited it blocked.
import { exec, execFile, execFileSync, execSync, spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";

type Name = "INT" | "TERM" | "HUP" | "USR2" | "PIPE";
const NAMES: Name[] = ["INT", "TERM", "HUP", "USR2", "PIPE"];
const selfSignal = (name: Name): string => `kill -${name} $$; echo survived`;

function thrown(e: unknown): string {
  const failure = e as Error & { status?: unknown; signal?: unknown };
  return `threw ${String(failure.status)} ${String(failure.signal)}`;
}

function synchronous(name: Name): void {
  const direct = spawnSync("/bin/sh", ["-c", selfSignal(name)], { encoding: "utf8" });
  console.log(name, "spawnSync", direct.status, direct.signal, JSON.stringify(direct.stdout));
  try {
    console.log(name, "execFileSync", JSON.stringify(execFileSync("/bin/sh", ["-c", selfSignal(name)], { encoding: "utf8" })));
  } catch (e) {
    console.log(name, "execFileSync", thrown(e));
  }
  try {
    console.log(name, "execSync", JSON.stringify(execSync(selfSignal(name), { encoding: "utf8" })));
  } catch (e) {
    console.log(name, "execSync", thrown(e));
  }
}

function collected(name: Name, child: ChildProcess, label: string): Promise<void> {
  return new Promise((resolve) => {
    let seen = "";
    child.stdout!.on("data", (chunk: Buffer) => {
      seen += chunk.toString();
    });
    child.on("close", (code, signal) => {
      console.log(name, label, code, signal, JSON.stringify(seen));
      resolve();
    });
  });
}

function calledBack(name: Name, label: string, start: (done: (error: Error | null, stdout: string) => void) => void): Promise<void> {
  return new Promise((resolve) => {
    start((error, stdout) => {
      const failure = error as (Error & { code?: unknown; signal?: unknown }) | null;
      console.log(name, label, failure === null ? "ok" : `${String(failure.code)} ${String(failure.signal)}`, JSON.stringify(stdout));
      resolve();
    });
  });
}

async function asynchronous(name: Name): Promise<void> {
  const command = selfSignal(name);
  await collected(name, spawn("/bin/sh", ["-c", command], { stdio: ["ignore", "pipe", "inherit"] }), "spawn");
  await collected(name, spawn("/bin/sh", ["-c", command], { detached: true, stdio: ["ignore", "pipe", "inherit"] }), "spawn detached");
  await calledBack(name, "exec", (done) => {
    exec(command, (error, stdout) => done(error, stdout));
  });
  await calledBack(name, "execFile", (done) => {
    execFile("/bin/sh", ["-c", command], (error, stdout) => done(error, stdout));
  });
}

// A signal sent by the program to a child that is doing something else.
function interrupted(signal: "SIGINT" | "SIGTERM"): Promise<void> {
  return new Promise((resolve) => {
    const began = Date.now();
    const sleeper = spawn("sleep", ["5"], { stdio: "ignore" });
    sleeper.on("exit", (code, name) => {
      console.log("kill", signal, code, name, sleeper.killed, Date.now() - began < 4000);
      resolve();
    });
    console.log("kill", signal, "sent", sleeper.kill(signal));
  });
}

async function inner(): Promise<void> {
  for (const name of NAMES) synchronous(name);
  for (const name of NAMES) await asynchronous(name);
  await interrupted("SIGINT");
  await interrupted("SIGTERM");
  // `yes` reports a failed write on stderr when SIGPIPE cannot end it.
  const pipeline = spawnSync("/bin/sh", ["-c", "yes | head -n 1"], { encoding: "utf8" });
  console.log("pipeline", pipeline.status, JSON.stringify(pipeline.stdout), JSON.stringify(pipeline.stderr));
}

// The second run knows itself by a variable perl sets, and by a marker
// argument: a run that has the marker without the variable stops, so a start
// that lost the variable can never start the program again.
if (process.env.SIGNAL_START_RUN === "second") {
  void inner();
} else if (process.argv.includes("second-run")) {
  console.log("second run without its variable");
  process.exitCode = 3;
} else {
  const block =
    "use POSIX; " +
    "$ENV{SIGNAL_START_RUN} = 'second'; " +
    "sigprocmask(SIG_BLOCK, POSIX::SigSet->new(SIGINT, SIGTERM, SIGHUP, SIGUSR2, SIGPIPE, SIGCHLD)) or die 'mask'; " +
    "exec @ARGV or die 'exec';";
  const run = spawnSync("perl", ["-e", block, process.execPath, process.argv[1], "second-run"], { stdio: "inherit" });
  console.log("second run", run.status, run.signal);
}
