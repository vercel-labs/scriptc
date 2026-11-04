// Two children wait for EOF on separate stdin pipes. Timers release them in a
// causal sequence, so the byte-for-byte oracle does not assume that an OS
// child finishes within a wall-clock gap on a loaded runner. A blocking
// child wait would prevent the timer that releases that child from firing.
import { spawn } from "node:child_process";

const slow = spawn("/bin/sh", ["-c", "read release; exit 0"], {
  stdio: ["pipe", "ignore", "ignore"],
});
slow.on("exit", (code) => {
  console.log("slow exit", code ?? -1);
  // Timers keep the loop alive after all children have exited too.
  setTimeout(() => {
    console.log("timer after exits");
  }, 1300);
});

const fast = spawn("/bin/sh", ["-c", "read release; exit 0"], {
  stdio: ["pipe", "ignore", "ignore"],
});
fast.on("exit", (code) => {
  console.log("fast exit", code ?? -1);
});

// A third child is spawned from an exit listener. Its stdin is released by
// another timer, pinning child reaping while timers and children coexist.
fast.on("exit", () => {
  const late = spawn("/bin/sh", ["-c", "read release; exit 9"], {
    stdio: ["pipe", "ignore", "ignore"],
  });
  late.on("exit", (code) => {
    console.log("late exit", code ?? -1);
    slow.stdin!.end();
  });
  setTimeout(() => {
    console.log("timer release late");
    late.stdin!.end();
  }, 0);
});

setTimeout(() => {
  console.log("timer release fast");
  fast.stdin!.end();
}, 700);

console.log("main done");
