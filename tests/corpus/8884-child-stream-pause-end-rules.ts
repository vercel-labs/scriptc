// When a paused child stream's 'end' fires. Node emits it one tick after
// the read that empties the stream at EOF, whether or not the stream is
// flowing then:
// - a listener that pauses on the last held chunk still gets 'end', and the
//   child's 'close' follows;
// - a paused stream that holds nothing at EOF ends at once, without a
//   resume, while the child is still running;
// - a paused stream that holds anything at EOF, even only the decoder's
//   replacement for a cut character, owes 'end' until that is read.
import { spawn } from "node:child_process";

function pauseOnLastChunk(): void {
  const log: string[] = [];
  const child = spawn("/bin/sh", ["-c", "printf abc"], { stdio: ["ignore", "pipe", "pipe"] });
  const out = child.stdout;
  if (out === null) throw new Error("stdout is piped");
  out.pause();
  out.on("data", (chunk: Buffer) => {
    log.push(`data ${chunk.toString()}`);
    out.pause();
  });
  out.on("end", () => {
    log.push(`end paused=${out.isPaused()}`);
  });
  child.on("exit", (code) => {
    log.push(`exit ${code}`);
  });
  child.on("close", (code) => {
    log.push(`close ${code} paused=${out.isPaused()}`);
    for (const line of log) console.log("pause-on-last-chunk:", line);
    nothingHeld();
  });
}

function nothingHeld(): void {
  const log: string[] = [];
  // The child closes its stdout and keeps running.
  const child = spawn("/bin/sh", ["-c", "exec 1>&-; sleep 0.8; exit 4"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const out = child.stdout;
  if (out === null) throw new Error("stdout is piped");
  let exited = false;
  out.pause();
  out.on("data", () => {
    log.push("data");
  });
  out.on("end", () => {
    log.push(`end paused=${out.isPaused()} exited=${exited}`);
  });
  child.on("exit", (code) => {
    exited = true;
    log.push(`exit ${code}`);
  });
  child.on("close", (code) => {
    log.push(`close ${code}`);
    for (const line of log) console.log("nothing-held:", line);
    cutCharacter();
  });
}

function cutCharacter(): void {
  const log: string[] = [];
  // Half of a two-byte character, then EOF: the decoder's replacement
  // character is held, so 'end' waits for the exit flush.
  const child = spawn("/bin/sh", ["-c", "printf '\\303'; exec 1>&-; sleep 0.8"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const out = child.stdout;
  if (out === null) throw new Error("stdout is piped");
  let exited = false;
  out.setEncoding("utf8");
  out.pause();
  out.on("data", (chunk: string) => {
    log.push(`data ${JSON.stringify(chunk)} exited=${exited}`);
  });
  out.on("end", () => {
    log.push(`end exited=${exited}`);
  });
  child.on("exit", (code) => {
    exited = true;
    log.push(`exit ${code}`);
  });
  child.on("close", (code) => {
    log.push(`close ${code}`);
    for (const line of log) console.log("cut-character:", line);
  });
}

pauseOnLastChunk();
