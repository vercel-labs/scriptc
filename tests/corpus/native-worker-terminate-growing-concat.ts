// worker.terminate() while a worker grows one string through the mixed
// self-append form (string + number + template) in a tight loop. The result
// must be stored into the binding before the pending check runs: the runtime
// releases the head it moved, so a check that ran first would unwind through
// the freed head and release it again (ASan use-after-free).
import { Worker, isMainThread, parentPort } from "node:worker_threads";

if (isMainThread) {
  const rounds = 40;
  let index = 0;
  const next = (): void => {
    if (index >= rounds) {
      console.log("terminate rounds done");
      return;
    }
    index++;
    const worker = new Worker(new URL(import.meta.url));
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      setTimeout(next, 1);
    };
    worker.on("exit", () => finish());
    // Long enough to be inside a concat when the terminate lands.
    setTimeout(() => {
      void worker.terminate();
    }, 3 + (index % 11));
  };
  next();
} else {
  let s = "start";
  let n = 0;
  for (;;) {
    s = s + "x" + (n & 7) + `${n % 3}`;
    n++;
    if (s.length > 50000) s = s.slice(s.length - 500);
    if ((n & 255) === 0) s += "y".repeat(20000);
  }
}
