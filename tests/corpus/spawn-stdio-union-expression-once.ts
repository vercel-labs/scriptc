// A union-typed stdio expression that has a side effect is read ONCE at the
// call: Node evaluates the options value once, so the three slots it feeds
// must agree, and the counter stays at one read.
import { spawn } from "node:child_process";

type Mode = "ignore" | "pipe";

let reads = 0;

function nextMode(): Mode {
  reads++;
  return "ignore";
}

function run(): void {
  const child = spawn("/bin/sh", ["-c", "printf 'hidden\\n' 1>&2; exit 3"], {
    stdio: nextMode(),
  });
  child.on("exit", (code) => {
    console.log("code=" + String(code), "reads=" + String(reads));
  });
}

run();
