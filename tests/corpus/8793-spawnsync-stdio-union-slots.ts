// spawnSync's stdio tuple may carry a slot TYPED as a union of the
// supported literals (the portable `cond ? "pipe" : "ignore"` slot): the
// slot's mode resolves at the call. Arms are told apart by leakage — an
// "inherit" stderr slot writes the child's text to OUR stderr, an
// "ignore" slot swallows it — and a "pipe" slot still captures into the
// result. Ignored result FIELDS are never read (Node types them null,
// this runtime reads "" — the documented spawnSync stance), so every line
// is deterministic.
import { spawnSync } from "node:child_process";

type Slot = "ignore" | "inherit" | "pipe";

function slot(errMode: Slot, label: string): void {
  const r = spawnSync("/bin/sh", ["-c", "printf 'leaked\\n' 1>&2; exit 6"], {
    encoding: "utf8",
    stdio: ["ignore", "ignore", errMode],
  });
  console.log(label, "status=" + String(r.status));
}

// A union-typed stdout slot: "pipe" captures, "inherit" leaks to ours.
function outSlot(mode: Slot, label: string): void {
  const r = spawnSync("/bin/sh", ["-c", "printf 'out line\\n'; exit 0"], {
    encoding: "utf8",
    stdio: ["ignore", mode, "ignore"],
  });
  // Reading the field is only Node-exact for the capturing arm.
  if (mode === "pipe") {
    console.log(label, "captured=" + JSON.stringify(r.stdout));
  } else {
    console.log(label, "status=" + String(r.status));
  }
}

// A union-typed stdin slot: whatever it resolves to reads nothing (no
// input is passed), so only the mode plumbing is under test.
function stdinSlot(mode: Slot, label: string): void {
  const r = spawnSync("/bin/cat", [], { encoding: "utf8", stdio: [mode, "pipe", "ignore"] });
  console.log(label, "status=" + String(r.status), "out=" + JSON.stringify(r.stdout));
}

console.log("start");
slot("ignore", "tuple-ignore");
slot("inherit", "tuple-inherit");
outSlot("pipe", "out-pipe");
outSlot("inherit", "out-inherit");
stdinSlot("pipe", "stdin-pipe");
stdinSlot("ignore", "stdin-ignore");
