// A paused child stream applies backpressure. It keeps reading until it
// holds its high-water mark (64 KiB), then stops, and the child blocks in
// write once the kernel's buffer is full too.
// - Four megabytes fit nowhere (a writer can grow a pipe to one megabyte):
//   the child stays in its write until the parent resumes, and then every
//   byte arrives.
// - 72,000 bytes fit the stream's buffer with the rest in the kernel's: the
//   child gets past its write while the parent is still paused, exits, and
//   the exit flush delivers the bytes.
// The child reports on stderr when it is past the write.
import { spawn } from "node:child_process";

function blocks(): void {
  const child = spawn("/bin/sh", ["-c", "head -c 4000000 /dev/zero; echo past >&2"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let bytes = 0;
  let nonZero = 0;
  let past = false;
  child.stdout?.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
    for (const byte of chunk) if (byte !== 0) nonZero++;
  });
  child.stdout?.pause();
  child.stderr?.on("data", () => {
    past = true;
  });
  setTimeout(() => {
    console.log(`blocks: paused bytes=${bytes} past=${past}`);
    child.stdout?.resume();
  }, 500);
  child.on("close", (code) => {
    console.log(`blocks: close ${code} bytes=${bytes} nonZero=${nonZero} past=${past}`);
    fits();
  });
}

function fits(): void {
  const child = spawn("/bin/sh", ["-c", "head -c 72000 /dev/zero; echo past >&2; sleep 0.3"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let bytes = 0;
  let pastWhilePaused = false;
  child.stdout?.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
  });
  child.stdout?.pause();
  child.stderr?.on("data", () => {
    pastWhilePaused = bytes === 0 && child.stdout?.isPaused() === true;
  });
  child.on("close", (code) => {
    console.log(`fits: close ${code} bytes=${bytes} pastWhilePaused=${pastWhilePaused}`);
  });
}

blocks();
