// child_process errors carry Node's own properties: the sync forms'
// status, signal, output, pid, stdout and stderr (Buffers, or strings with
// an encoding option), the async forms' code, killed, signal and cmd (with
// stdout and stderr when promisified), and a spawn failure's errno,
// syscall, path and spawnargs. Pids vary, so only their type prints.
import { exec, execFile, execFileSync, execSync } from "node:child_process";
import { inspect, promisify } from "node:util";

const execFileAsync = promisify(execFile);

function keys(e: unknown): string {
  return Object.keys(e as object).join(",");
}

function show(label: string, e: unknown): void {
  if (!(e instanceof Error)) return;
  const value: unknown = e;
  const pid = typeof (value as { pid?: number }).pid;
  e.stack = "";
  const text = inspect(e).replace(/pid: \d+/, "pid: <pid>");
  console.log(label, pid, keys(e));
  console.log(text);
}

try {
  execFileSync("/bin/sh", ["-c", "echo out; echo err 1>&2; exit 3"], { stdio: "pipe" });
} catch (e) {
  const err = e as { status?: number | null; signal?: string | null; stdout?: Buffer; stderr?: Buffer };
  console.log("status", err.status, err.signal, err.stdout?.toString(), err.stderr?.toString());
  show("execFileSync", e);
}
try {
  execSync("echo text; exit 4", { encoding: "utf8", stdio: "pipe" });
} catch (e) {
  const err = e as { status?: number | null; stdout?: string; output?: (string | null)[] };
  console.log("encoding", err.status, JSON.stringify(err.stdout), inspect(err.output));
}
try {
  execSync("exit 5", { stdio: "ignore" });
} catch (e) {
  const err = e as { output?: unknown[]; stdout?: unknown };
  console.log("ignored", inspect(err.output), err.stdout);
}
try {
  execFileSync("/bin/sh", ["-c", "kill -TERM $$"], { stdio: "pipe" });
} catch (e) {
  const err = e as { status?: number | null; signal?: string | null };
  console.log("signal", err.status, err.signal);
}
try {
  execFileSync("/no/such/binary", ["a", "b"]);
} catch (e) {
  show("spawn failure", e);
  const err = e as { errno?: number; syscall?: string; path?: string; spawnargs?: string[] };
  console.log(err.errno, err.syscall, err.path, inspect(err.spawnargs));
}
try {
  execFileSync("/bin/sh", ["-c", "echo partial; exec sleep 5"], { timeout: 100, stdio: "pipe" });
} catch (e) {
  const err = e as { code?: string; status?: number | null; signal?: string | null; stdout?: Buffer };
  console.log("timeout", err.code, err.status, err.signal, err.stdout?.toString());
}

execFile("/bin/sh", ["-c", "echo o; exit 6"], (err, stdout) => {
  const fields: unknown = err;
  const e = fields as { code?: number | null; killed?: boolean; signal?: string | null; cmd?: string };
  console.log("callback", e.code, e.killed, e.signal, e.cmd, JSON.stringify(stdout));
  show("callback error", err);
  execFile("/no/such/binary", ["x"], (missing) => {
    show("callback spawn failure", missing);
    exec("echo shell; exit 4", (shellError) => {
      show("exec callback", shellError);
      void promised();
    });
  });
});

async function promised(): Promise<void> {
  try {
    await execFileAsync("/bin/sh", ["-c", "echo po; echo pe 1>&2; exit 7"]);
  } catch (e) {
    show("promisified", e);
  }
  try {
    await execFileAsync("/bin/sh", ["-c", "exec sleep 5"], { timeout: 100 });
  } catch (e) {
    const err = e as { code?: number | null; killed?: boolean; signal?: string | null };
    console.log("promisified timeout", err.code, err.killed, err.signal);
  }
  try {
    await execFileAsync("/no/such/binary");
  } catch (e) {
    show("promisified spawn failure", e);
  }
}
