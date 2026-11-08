// A forked module starts with the standard signals at their default actions
// even when the program that forks it was itself started with them ignored:
// a signal the module sends to itself ends it, and so does one the parent
// sends. The program runs itself through /bin/sh as it is and again after
// `trap '' ...` (ignored dispositions survive an exec), so both start states
// are pinned however the test itself was started.
import { fork, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
const worker = fileURLToPath(new URL(`./worker.${extension}`, import.meta.url));

function own(signal: string): Promise<void> {
  return new Promise((resolve) => {
    const child = fork(worker, ["own", signal], { stdio: ["ignore", "inherit", "inherit", "ipc"] });
    child.on("exit", (code, name) => {
      console.log("own", signal, code, name);
      resolve();
    });
  });
}

function sent(signal: "SIGINT" | "SIGTERM" | "SIGHUP"): Promise<void> {
  return new Promise((resolve) => {
    const began = Date.now();
    const child = fork(worker, ["wait"], { stdio: ["ignore", "inherit", "inherit", "ipc"] });
    child.on("message", (message: { ready: boolean }) => {
      console.log("sent", signal, message.ready, child.kill(signal));
    });
    child.on("exit", (code, name) => {
      console.log("sent", signal, code, name, Date.now() - began < 4000);
      resolve();
    });
  });
}

async function inner(): Promise<void> {
  await own("SIGINT");
  await own("SIGTERM");
  await own("SIGHUP");
  await own("SIGUSR2");
  await sent("SIGINT");
  await sent("SIGTERM");
  await sent("SIGHUP");
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
    ["signals ignored", `trap '' INT TERM HUP USR2 CHLD; exec "$@"`],
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
