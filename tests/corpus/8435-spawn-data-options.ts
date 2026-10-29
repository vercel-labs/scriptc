// @no-deprecation
// spawn's and spawnSync's options carried as DATA — the platform idioms a
// portable CLI writes: a 3-tuple stdio slot that is a CONDITIONAL over the
// stdio literals, a slot typed as a union of them, `detached:
// process.platform === "win32"`, and `shell: process.platform === "win32"`
// (Node joins [file, ...args] with " " and runs the result through
// /bin/sh -c when the flag is true, so an argument carrying ";" splits into
// two commands only on the shell arm). Under Node every value above is
// decided at the call, and the compiled program must agree exactly.
// @no-deprecation is for Node's DEP0190 ("passing args to a child process
// with shell option true"), which has no native counterpart.
import { spawn, spawnSync } from "node:child_process";

// The stdin slot is a conditional over "pipe"/"ignore" (the
// `commandTransport === "stdin"` shape); detached is a runtime boolean
// that is false here (the child stays in the parent's process group).
function run(command: string, args: string[], pipedStdin: boolean, input: string): Promise<void> {
  return new Promise<void>((resolve) => {
    const child = spawn(command, args, {
      stdio: [pipedStdin ? "pipe" : "ignore", "pipe", "pipe"],
      detached: process.platform === "win32",
      windowsHide: true,
    });
    let out = "";
    let err = "";
    child.stdout?.on("data", (chunk) => {
      out += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      err += chunk.toString();
    });
    child.on("close", (code) => {
      console.log(
        `run piped=${pipedStdin} close=${code} out=${JSON.stringify(out)} err=${JSON.stringify(err)}`,
      );
      resolve();
    });
    if (pipedStdin) {
      const stdin = child.stdin;
      if (stdin !== null) {
        stdin.on("error", () => {});
        stdin.write(input);
        stdin.end();
      }
    }
  });
}

await run("/bin/sh", ["-c", "cat; echo tail 1>&2"], true, "piped-through\n");
await run("/bin/sh", ["-c", "cat; echo tail 1>&2"], false, "");

// A runtime `shell` boolean: false spawns the file with its argv intact,
// true joins file+args for /bin/sh -c.
function runShell(shellOn: boolean): Promise<void> {
  return new Promise<void>((resolve) => {
    const child = spawn("/bin/echo", ["first; echo second"], {
      stdio: ["ignore", "pipe", "pipe"],
      shell: shellOn,
    });
    let text = "";
    child.stdout?.on("data", (chunk) => {
      text += chunk.toString();
    });
    child.on("close", (code) => {
      console.log(`shell=${shellOn} close=${code} out=${JSON.stringify(text)}`);
      resolve();
    });
  });
}

await runShell(false);
await runShell(true);

// spawnSync: the tuple slot carries a value typed as a union of the
// literals (a read, not a conditional), and shell: false is Node's
// default spelled out. Only the captured streams are read — an "ignore"
// slot reads "" here where Node types null (the documented stance).
function runSync(capturing: boolean): void {
  const slot: "pipe" | "ignore" = capturing ? "pipe" : "ignore";
  const result = spawnSync("/bin/sh", ["-c", "echo out-line; echo err-line 1>&2"], {
    encoding: "utf-8",
    stdio: [slot, "pipe", slot],
    shell: false,
    windowsHide: true,
  });
  if (capturing) {
    console.log(`sync status=${result.status} out=${JSON.stringify(result.stdout)} err=${JSON.stringify(result.stderr)}`);
  } else {
    console.log(`sync status=${result.status} out=${JSON.stringify(result.stdout)}`);
  }
}

runSync(true);
runSync(false);
