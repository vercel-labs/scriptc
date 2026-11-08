// pause() on a child's stdout before any listener, and what ends it: Node
// resumes a child's stdio streams on the tick after the 'exit' listeners
// (flushStdio), so a pause does not outlive the child, not even one made
// inside an 'exit' listener. While paused no 'data' fires, a listener added
// then does not resume the stream, and isPaused() / readableFlowing answer
// Node's values in every state. An execFile() callback still comes after
// the paused stream's events.
import { execFile, spawn } from "node:child_process";

function beforeAnyListener(): void {
  const log: string[] = [];
  const child = spawn("/bin/sh", ["-c", "printf abc; exit 2"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const out = child.stdout;
  if (out === null) throw new Error("stdout is piped");
  log.push(`initial ${out.isPaused()} ${out.readableFlowing}`);
  out.pause();
  log.push(`paused ${out.isPaused()} ${out.readableFlowing}`);
  let text = "";
  let exitSeen = false;
  out.on("data", (chunk: Buffer) => {
    text += chunk.toString();
    log.push(`data exitSeen=${exitSeen}`);
  });
  log.push(`listening ${out.isPaused()} ${out.readableFlowing}`);
  out.on("end", () => {
    log.push("end");
  });
  child.on("exit", (code) => {
    exitSeen = true;
    log.push(`exit ${code} paused=${out.isPaused()}`);
    // Queued before the flush: the stream is still paused here.
    process.nextTick(() => {
      log.push(`tick paused=${out.isPaused()}`);
    });
  });
  child.on("close", () => {
    log.push(`close text=${text} paused=${out.isPaused()} flowing=${out.readableFlowing}`);
    for (const line of log) console.log("before-any-listener:", line);
    inExitListener();
  });
}

function inExitListener(): void {
  const log: string[] = [];
  const child = spawn("/bin/sh", ["-c", "printf tail"], { stdio: ["ignore", "pipe", "pipe"] });
  let text = "";
  child.stdout?.pause();
  child.stdout?.on("data", (chunk: Buffer) => {
    text += chunk.toString();
  });
  child.on("exit", () => {
    // The flush runs after the listeners, so this pause is undone too.
    child.stdout?.pause();
    log.push(`exit text=${text} paused=${child.stdout?.isPaused()}`);
  });
  child.on("close", (code) => {
    log.push(`close ${code} text=${text} paused=${child.stdout?.isPaused()}`);
    for (const line of log) console.log("in-exit-listener:", line);
    stderrToo();
  });
}

function stderrToo(): void {
  // Both streams paused, as a caller that stops collecting output does; the
  // flush resumes each.
  const child = spawn("/bin/sh", ["-c", "printf out; printf err >&2; exit 1"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  let err = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    out += chunk.toString();
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    err += chunk.toString();
  });
  child.stdout?.pause();
  child.stderr?.pause();
  child.on("exit", (code) => {
    console.log(`both: exit ${code} out=${out} err=${err}`);
  });
  child.on("close", (code) => {
    console.log(`both: close ${code} out=${out} err=${err}`);
    withCallback();
  });
}

function withCallback(): void {
  // execFile's callback comes after the stream's events, paused or not.
  const log: string[] = [];
  const child = execFile("/bin/sh", ["-c", "printf hello"], (error, stdout) => {
    log.push(`callback failed=${error !== null} stdout=${stdout}`);
    for (const line of log) console.log("callback:", line);
  });
  child.stdout?.on("data", () => {
    log.push("data");
  });
  child.stdout?.on("end", () => {
    log.push("end");
  });
  child.stdout?.pause();
  child.on("exit", (code) => {
    log.push(`exit ${code} paused=${child.stdout?.isPaused()}`);
  });
}

beforeAnyListener();
