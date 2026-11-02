// spawn's stdio slots may be TYPED as a union of the supported literals —
// the portable platform-conditional slot `cond ? "pipe" : "ignore"` — so
// each slot's mode resolves at the call, not at compile time. The arms are
// told apart by leakage: an "inherit" slot puts the child's stderr on OUR
// stderr, an "ignore" slot swallows it. Every line is deterministic
// (status after 'exit', never chunk sizes).
import { spawn } from "node:child_process";

type Slot = "ignore" | "inherit" | "pipe";

// A tuple slot whose value decides between inheriting and ignoring the
// child's stderr; stdin takes the same union (both arms read nothing).
function slot(stdinMode: Slot, errMode: Slot, label: string, next: () => void): void {
  const child = spawn("/bin/sh", ["-c", "printf 'leaked\\n' 1>&2; exit 5"], {
    stdio: [stdinMode, "ignore", errMode],
  });
  child.on("exit", (code: number | null) => {
    console.log(label, "code=" + String(code));
    next();
  });
}

// The scalar form takes the same literals; an inherited stdout carries the
// child's text on OUR stdout.
function scalar(mode: Slot, label: string, next: () => void): void {
  const child = spawn("/bin/sh", ["-c", "printf 'scalar line\\n'; exit 1"], { stdio: mode });
  child.on("exit", (code: number | null) => {
    console.log(label, "code=" + String(code));
    next();
  });
}

function main(): void {
  // Both arms of one union-typed tuple slot, then the scalar union.
  slot("ignore", "ignore", "tuple-ignore", () => {
    slot("pipe", "inherit", "tuple-inherit", () => {
      scalar("inherit", "scalar-inherit", () => {});
    });
  });
}

main();
