// pause() inside a 'data' handler and resume() from a timer. Nothing is
// delivered in between; what the child wrote meanwhile is held by the stream
// and comes out on the tick after resume(), before a tick queued after the
// call, in the order it was written.
import { spawn } from "node:child_process";

const log: string[] = [];
const child = spawn("/bin/sh", ["-c", "printf one; sleep 0.3; printf two; sleep 1; printf three"], {
  stdio: ["ignore", "pipe", "pipe"],
});
let text = "";
let paused = false;
let deliveredWhilePaused = 0;
child.stdout?.on("data", (chunk: Buffer) => {
  if (paused) deliveredWhilePaused++;
  text += chunk.toString();
  if (text !== "one") return;
  child.stdout?.pause();
  paused = true;
  log.push(`pause isPaused=${child.stdout?.isPaused()}`);
  setTimeout(() => {
    // "two" arrived 500 ms ago and is held back.
    log.push(`before resume text=${text}`);
    paused = false;
    child.stdout?.resume();
    log.push(`after resume isPaused=${child.stdout?.isPaused()} text=${text}`);
    process.nextTick(() => {
      log.push(`tick text=${text}`);
    });
    void Promise.resolve().then(() => {
      log.push(`microtask text=${text}`);
    });
  }, 800);
});
child.stdout?.on("end", () => {
  log.push("end");
});
child.on("close", (code) => {
  log.push(`close ${code} text=${text} deliveredWhilePaused=${deliveredWhilePaused}`);
  for (const line of log) console.log(line);
});
