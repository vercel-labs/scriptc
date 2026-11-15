// A paused child stream with an encoding holds decoded text. A character
// split across two writes is still one character; a once listener that
// pauses, and a listener added while paused, see what Node shows them; and
// setEncoding() on a stream that already holds raw chunks decodes them into
// one string, which arrives as one 'data' however the child's writes were
// read.
import { spawn } from "node:child_process";

function heldText(): void {
  const log: string[] = [];
  const script = "printf 'h\\303'; sleep 0.3; printf '\\251llo'; sleep 1; printf ' end'";
  const child = spawn("/bin/sh", ["-c", script], { stdio: ["ignore", "pipe", "pipe"] });
  const out = child.stdout;
  if (out === null) throw new Error("stdout is piped");
  out.setEncoding("utf8");
  let all = "";
  let onceText = "";
  let lateText = "";
  out.once("data", (chunk: string) => {
    onceText = chunk;
    out.pause();
    // Added during the emit and while paused: it gets what follows.
    out.on("data", (later: string) => {
      lateText += later;
    });
    setTimeout(() => {
      log.push(`paused all=${all} late=${lateText}`);
      out.resume();
    }, 800);
  });
  out.on("data", (chunk: string) => {
    all += chunk;
  });
  child.on("close", (code) => {
    log.push(`close ${code} once=${onceText} all=${all} late=${lateText}`);
    for (const line of log) console.log("held-text:", line);
    encodedLater();
  });
}

function encodedLater(): void {
  const script = "printf 'ab'; sleep 0.3; printf 'c\\303'; sleep 0.3; printf '\\251d'; sleep 1";
  const child = spawn("/bin/sh", ["-c", script], { stdio: ["ignore", "pipe", "pipe"] });
  const out = child.stdout;
  if (out === null) throw new Error("stdout is piped");
  out.pause();
  const chunks: string[] = [];
  setTimeout(() => {
    out.setEncoding("utf8");
    out.on("data", (chunk: string) => {
      chunks.push(chunk);
    });
    out.resume();
  }, 1100);
  child.on("close", (code) => {
    console.log(`encoded-later: close ${code} chunks=${JSON.stringify(chunks)}`);
  });
}

heldText();
