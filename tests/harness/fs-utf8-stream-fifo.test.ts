/* fs.Utf8Stream opens its destination inline, so a FIFO with no writer
 * would park that open forever (Node's default open rides the threadpool
 * and waits for one). The open carries O_NONBLOCK: without a reader the
 * kernel answers ENXIO, which the default stream reports as an 'error' event
 * after the constructor returned (Node's threadpool open reports it that
 * way), and a FIFO that has a reader still opens. A write to a FIFO whose
 * reader has stopped is performed on the worker pool, so it cannot block
 * timers. Only the native program is run — Node would block on the open,
 * which is the divergence this pins. */
import { closeSync, constants, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const sanitize = process.env["SCRIPTC_SAN"] === "1";

test.skipIf(process.platform !== "linux")("a FIFO open does not park the process", async () => {
  const outDir = mkdtempSync(join(tmpdir(), "scriptc-utf8-fifo-"));
  const fifo = join(outDir, "pipe");
  execFileSync("mkfifo", [fifo]);
  const entry = join(outDir, "main.mjs");
  writeFileSync(
    entry,
    `import fs from "node:fs";

const stream = new fs.Utf8Stream({ dest: ${JSON.stringify(fifo)} });
stream.on("error", (error) => console.log("error", error.code));
stream.on("ready", () => {
  console.log("opened");
  stream.destroy();
});
console.log("constructed");
`,
  );
  const result = await compile(entry, {
    backend: "llvm",
    sanitize,
    outDir,
    outPath: join(outDir, "program"),
  });
  expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true);
  if (!result.ok) return;

  // No reader: the open answers ENXIO instead of waiting for one.
  const blocked = spawnSync(result.binaryPath, [], { encoding: "utf8", timeout: 20000 });
  expect(blocked.error).toBeUndefined();
  expect(blocked.status).toBe(0);
  expect(blocked.stdout).toBe("constructed\nerror ENXIO\n");

  // A reader (an O_NONBLOCK read-open is one) makes the same open succeed.
  const reader = openSync(fifo, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const opened = spawnSync(result.binaryPath, [], { encoding: "utf8", timeout: 20000 });
    expect(opened.error).toBeUndefined();
    expect(opened.status).toBe(0);
    expect(opened.stdout).toBe("constructed\nopened\n");

    // The reader stays open but never reads. A 1 MiB write fills the pipe's
    // buffer; it must run off the event-loop thread, or the timer that
    // reports and exits never fires.
    const stalled = join(outDir, "stalled.mjs");
    writeFileSync(
      stalled,
      `import fs from "node:fs";

const stream = new fs.Utf8Stream({ dest: ${JSON.stringify(fifo)} });
stream.on("error", (error) => console.log("error", error.code));
stream.on("ready", () => {
  const accepted = stream.write("x".repeat(1024 * 1024));
  console.log("write returned", accepted);
  setTimeout(() => {
    console.log("timer");
    process.exit(0);
  }, 500);
});
`,
    );
    const built = await compile(stalled, {
      backend: "llvm",
      sanitize,
      outDir,
      outPath: join(outDir, "stalled"),
    });
    expect(built.ok, JSON.stringify(built.diagnostics)).toBe(true);
    if (!built.ok) return;
    const responsive = spawnSync(built.binaryPath, [], { encoding: "utf8", timeout: 20000 });
    expect(responsive.error).toBeUndefined();
    expect(responsive.status).toBe(0);
    expect(responsive.stdout).toContain("timer\n");
  } finally {
    closeSync(reader);
    rmSync(outDir, { recursive: true, force: true });
  }
});
