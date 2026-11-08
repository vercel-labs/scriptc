// 'end' and 'close' that arrive while a stream is paused are owed, not lost.
// A grandchild keeps the pipe open past the child's exit, so the parent can
// pause after the exit flush; the grandchild then writes and the pipe ends
// while the stream is paused. Nothing fires until resume(): then the held
// data, 'end', and the child's 'close', in that order.
import { spawn } from "node:child_process";

const log: string[] = [];
const child = spawn("/bin/sh", ["-c", "(sleep 0.6; printf late) & printf early; exit 0"], {
  stdio: ["ignore", "pipe", "pipe"],
});
let text = "";
let ended = false;
let closed = false;
child.stdout?.on("data", (chunk: Buffer) => {
  text += chunk.toString();
  if (ended) log.push("data after end");
});
child.stdout?.on("end", () => {
  ended = true;
  log.push(`end text=${text} closed=${closed}`);
});
child.on("exit", (code) => {
  setTimeout(() => {
    child.stdout?.pause();
    log.push(`pause after exit ${code} text=${text}`);
    setTimeout(() => {
      log.push(`still paused text=${text} ended=${ended} closed=${closed}`);
      child.stdout?.resume();
    }, 1100);
  }, 100);
});
child.on("close", (code) => {
  closed = true;
  log.push(`close ${code} text=${text} ended=${ended}`);
  for (const line of log) console.log(line);
});
