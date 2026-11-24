/* fs.Utf8Stream opens its destination inline, so a FIFO with no writer
 * would park that open forever (Node's default open rides the threadpool
 * and waits for one). The open carries O_NONBLOCK: without a reader the
 * kernel answers ENXIO, which the constructor reports at the call, and a
 * FIFO that has a reader still opens. Only the native program is run — Node
 * would block, which is the divergence this pins. */
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

try {
  const stream = new fs.Utf8Stream({ dest: ${JSON.stringify(fifo)} });
  stream.destroy();
  console.log("opened");
} catch (error) {
  console.log("error", error.code);
}
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
  expect(blocked.stdout).toBe("error ENXIO\n");

  // A reader (an O_NONBLOCK read-open is one) makes the same open succeed.
  const reader = openSync(fifo, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const opened = spawnSync(result.binaryPath, [], { encoding: "utf8", timeout: 20000 });
    expect(opened.error).toBeUndefined();
    expect(opened.status).toBe(0);
    expect(opened.stdout).toBe("opened\n");
  } finally {
    closeSync(reader);
    rmSync(outDir, { recursive: true, force: true });
  }
});
