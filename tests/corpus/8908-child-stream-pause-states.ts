// The flowing state of a child stream in every position: pause() and
// resume() are idempotent and the last one in a tick wins; after 'end' they
// only change what isPaused() and readableFlowing answer; and resume() on a
// stream with no 'data' listener drains it to nowhere, so a listener added
// later gets only what arrives after.
import { spawn } from "node:child_process";

function repeated(): void {
  const log: string[] = [];
  const child = spawn("/bin/sh", ["-c", "printf x; sleep 0.8; printf y"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const out = child.stdout;
  if (out === null) throw new Error("stdout is piped");
  let text = "";
  out.on("data", (chunk: Buffer) => {
    text += chunk.toString();
    if (text !== "x") return;
    out.pause();
    out.pause();
    out.resume();
    out.resume();
    out.pause();
    log.push(`x paused=${out.isPaused()} flowing=${out.readableFlowing}`);
    setTimeout(() => {
      log.push(`timer text=${text} paused=${out.isPaused()}`);
      out.pause();
      out.resume();
      log.push(`timer paused=${out.isPaused()} flowing=${out.readableFlowing}`);
    }, 300);
  });
  out.on("end", () => {
    log.push(`end text=${text} paused=${out.isPaused()} flowing=${out.readableFlowing}`);
    out.pause();
    log.push(`after end, pause: ${out.isPaused()} ${out.readableFlowing}`);
    out.resume();
    log.push(`after end, resume: ${out.isPaused()} ${out.readableFlowing}`);
    out.pause();
  });
  child.on("close", (code) => {
    log.push(`close ${code} paused=${out.isPaused()} flowing=${out.readableFlowing}`);
    for (const line of log) console.log("repeated:", line);
    noListener();
  });
}

function noListener(): void {
  const log: string[] = [];
  const child = spawn("/bin/sh", ["-c", "printf first; sleep 0.6; printf second"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const out = child.stdout;
  if (out === null) throw new Error("stdout is piped");
  log.push(`initial ${out.isPaused()} ${out.readableFlowing}`);
  out.resume();
  log.push(`resumed ${out.isPaused()} ${out.readableFlowing}`);
  let text = "";
  setTimeout(() => {
    out.on("data", (chunk: Buffer) => {
      text += chunk.toString();
    });
  }, 300);
  out.on("end", () => {
    log.push(`end text=${text}`);
  });
  child.on("close", (code) => {
    log.push(`close ${code}`);
    for (const line of log) console.log("no-listener:", line);
    chained();
  });
}

function chained(): void {
  // pause() and resume() return the stream.
  const child = spawn("/bin/sh", ["-c", "printf z"], { stdio: ["ignore", "pipe", "pipe"] });
  const out = child.stdout;
  if (out === null) throw new Error("stdout is piped");
  const same = out.pause();
  console.log(`chained: paused=${same.isPaused()} resumed=${same.resume().isPaused()}`);
  let text = "";
  out.on("data", (chunk: Buffer) => {
    text += chunk.toString();
  });
  child.on("close", (code) => {
    console.log(`chained: close ${code} text=${text}`);
  });
}

repeated();
