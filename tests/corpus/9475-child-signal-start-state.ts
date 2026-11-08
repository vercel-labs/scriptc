// A child process starts with the standard signals at their default actions,
// whatever signal state the program itself was started with. A program that
// inherited SIGINT as ignored (a background job of a non-interactive shell,
// a step of a build pipeline; SIGHUP under nohup) can still end its children
// with that signal, and a program that inherited SIGCHLD as ignored still
// reads their exit statuses.
//
// The program runs itself twice through /bin/sh: once as it is, and once
// after `trap '' ...`, which ignores the signals (ignored dispositions
// survive an exec). Both start states are therefore pinned however the test
// itself was started. Every child is a shell that sends the signal to itself:
// "survived" would mean the child had inherited it ignored.
import { exec, execFile, execFileSync, execSync, spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";

type Name = "INT" | "TERM" | "HUP" | "QUIT" | "USR1" | "PIPE";
const NAMES: Name[] = ["INT", "TERM", "HUP", "QUIT", "USR1", "PIPE"];
// No core file for the signals whose default action writes one.
const selfSignal = (name: Name): string => `ulimit -c 0; kill -${name} $$; echo survived`;

function thrown(e: unknown): string {
  const failure = e as Error & { status?: unknown; signal?: unknown };
  return `threw ${String(failure.status)} ${String(failure.signal)}`;
}

function synchronous(name: Name): void {
  const direct = spawnSync("/bin/sh", ["-c", selfSignal(name)], { encoding: "utf8" });
  console.log(name, "spawnSync", direct.status, direct.signal, JSON.stringify(direct.stdout));
  const inherited = spawnSync("/bin/sh", ["-c", `ulimit -c 0; kill -${name} $$`], { stdio: "inherit" });
  console.log(name, "spawnSync inherit", inherited.status, inherited.signal);
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

function ended(name: Name, label: string, child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    child.on("exit", (code, signal) => {
      console.log(name, label, code, signal);
      resolve();
    });
  });
}

async function asynchronous(name: Name): Promise<void> {
  const command = selfSignal(name);
  await collected(name, spawn("/bin/sh", ["-c", command], { stdio: ["ignore", "pipe", "inherit"] }), "spawn");
  await collected(name, spawn("/bin/sh", ["-c", command], { detached: true, stdio: ["ignore", "pipe", "inherit"] }), "spawn detached");
  await collected(name, spawn(command, [], { shell: true, stdio: ["ignore", "pipe", "inherit"] }), "spawn shell");
  await ended(name, "spawn inherit", spawn("/bin/sh", ["-c", `ulimit -c 0; kill -${name} $$`], { stdio: "inherit" }));
  await calledBack(name, "exec", (done) => {
    exec(command, (error, stdout) => done(error, stdout));
  });
  await calledBack(name, "execFile", (done) => {
    execFile("/bin/sh", ["-c", command], (error, stdout) => done(error, stdout));
  });
}

// A signal sent by the program to a child that is doing something else.
function interrupted(signal: "SIGINT" | "SIGTERM" | "SIGHUP" | "SIGQUIT"): Promise<void> {
  return new Promise((resolve) => {
    const began = Date.now();
    const sleeper = spawn("/bin/sh", ["-c", "ulimit -c 0; exec sleep 5"], { stdio: "ignore" });
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
  await interrupted("SIGHUP");
  await interrupted("SIGQUIT");
  // The left side of a pipeline ends by SIGPIPE when the right side has read enough.
  console.log("pipeline", JSON.stringify(execSync("yes | head -n 1", { encoding: "utf8" })));
}

// The second run knows itself by a variable the shell exports, and by a marker
// argument: a run that has the marker without the variable stops, so a start
// that lost the variable can never start the program again.
if (process.env.SIGNAL_START_RUN === "second") {
  void inner();
} else if (process.argv.includes("second-run")) {
  console.log("second run without its variable");
  process.exitCode = 3;
} else {
  const starts: [string, string][] = [
    ["as started", 'exec "$@"'],
    ["signals ignored", `trap '' INT TERM HUP QUIT USR1 PIPE CHLD; exec "$@"`],
  ];
  for (const [label, script] of starts) {
    console.log(`== ${label}`);
    const run = spawnSync(
      "/bin/sh",
      ["-c", `SIGNAL_START_RUN=second; export SIGNAL_START_RUN; ${script}`, "sh", process.execPath, process.argv[1], "second-run"],
      { stdio: "inherit" },
    );
    console.log("second run", run.status, run.signal);
  }
}
