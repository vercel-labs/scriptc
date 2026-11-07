// A stdio slot read as a property of a computed value: the mode mapping
// compares the slot once per arm, so the value's receiver must evaluate
// once, as an array element does. The receiver counts its calls and answers
// a different mode after the first, so a repeated evaluation both repeats
// the side effect and can pick a stdio mode Node never picks.
import { spawnSync } from "node:child_process";

type Mode = "pipe" | "ignore" | "inherit";

let calls = 0;

function modes(): { mode: Mode } {
  calls++;
  return { mode: calls === 1 ? "pipe" : "inherit" };
}

const r = spawnSync("/bin/sh", ["-c", "printf 'child line\\n' >&2"], {
  encoding: "utf8",
  stdio: ["pipe", "pipe", modes().mode],
});

console.log(`calls ${calls}`);
console.log(`status ${r.status === null ? "null" : r.status}`);
console.log(`stderr ${JSON.stringify(r.stderr)}`);
