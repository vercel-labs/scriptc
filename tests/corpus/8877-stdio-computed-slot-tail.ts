// The stdio-slot tail the union-slot corpus leaves out: every slot of
// spawn's 3-tuple computed from one value (stdout included), a computed
// slot beside literal ones together with the other spawn options, and
// spawnSync's computed stdin deciding at the call whether `input` reaches
// the child. Arms are told apart by leakage and by the captured line; every
// line is deterministic (the status after 'exit', never a chunk size).
import { spawn, spawnSync } from "node:child_process";

type Slot = "ignore" | "inherit" | "pipe";

// All three slots computed from the same union: "inherit" passes the
// child's stdout through to ours, "ignore" and "pipe" swallow it.
function run(mode: Slot, label: string, next: () => void): void {
  const child = spawn("/bin/sh", ["-c", "printf 'from-child\\n'"], {
    cwd: process.cwd(),
    detached: false,
    stdio: [mode, mode, mode],
    windowsHide: true,
  });
  child.on("error", () => {
    console.log(label, "spawn-error");
    next();
  });
  child.on("exit", (code: number | null) => {
    console.log(label, "code=" + String(code));
    next();
  });
}

// The inline census shape: two computed slots (both always on the literal
// "inherit" arm here) beside a literal one.
function inline(next: () => void): void {
  const useStdin = process.argv.length > 99;
  const child = spawn("/bin/sh", ["-c", "printf 'ternary\\n'"], {
    stdio: [useStdin ? "pipe" : "inherit", useStdin ? "pipe" : "inherit", "inherit"],
  });
  child.on("error", () => {
    console.log("ternary spawn-error");
    next();
  });
  child.on("exit", (code: number | null) => {
    console.log("ternary code=" + String(code));
    next();
  });
}

// fd 0 carries `input` only when the slot resolves to "pipe"; "ignore" and
// "inherit" take fd 0 away from the child, as Node does.
function cat(mode: Slot, input: string | undefined): string {
  const r = spawnSync("/bin/sh", ["-c", "cat"], {
    encoding: "utf8",
    input,
    stdio: [mode, "pipe", "pipe"],
  });
  return `stdin=${mode} input=${input === undefined ? "none" : "text"} status=${String(r.status)} out=${JSON.stringify(r.stdout)}`;
}

// Computed output slots beside a literal "pipe": "inherit" hands the child
// the parent's fd, "ignore" sends it to /dev/null.
function echo(which: "stdout" | "stderr", mode: Slot): void {
  const r = spawnSync("/bin/sh", ["-c", "printf 'child-line\\n' 1>&2"], {
    encoding: "utf8",
    stdio: ["ignore", which === "stdout" ? mode : "pipe", which === "stderr" ? mode : "pipe"],
  });
  console.log(`fd=${which} mode=${mode} status=${String(r.status)}`);
}

run("inherit", "all-inherit", () => {
  run("ignore", "all-ignore", () => {
    run("pipe", "all-pipe", () => {
      inline(() => {
        // A computed stdin slot with no `input` option: nothing to pipe, and
        // the child still sees EOF on its piped fd 0.
        console.log(cat("pipe", undefined));
        echo("stdout", "inherit");
        echo("stdout", "ignore");
        echo("stderr", "inherit");
        echo("stderr", "ignore");

        // The census shape: a flag-computed stdin slot beside literal ones,
        // with the options a config resolver passes.
        const commandFromStdin = process.argv.length > 99;
        const census = spawnSync("/bin/sh", ["-c", "printf 'inline\\n'"], {
          encoding: "utf8",
          input: commandFromStdin ? "x" : undefined,
          timeout: 10_000,
          stdio: [commandFromStdin ? "pipe" : "ignore", "pipe", "ignore"],
          shell: false,
          windowsHide: true,
        });
        console.log(`census status ${String(census.status)} out ${JSON.stringify(census.stdout)}`);
      });
    });
  });
});
