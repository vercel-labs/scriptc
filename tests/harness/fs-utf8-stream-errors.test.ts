/* A Utf8Stream 'error' with no listener is Node's uncaught exception: the
 * deferred asynchronous open or write failure ends the process instead of
 * being dropped. Only the native program is run; the corpus programs cover
 * the listener-visible ordering against Node. */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const sanitize = process.env["SCRIPTC_SAN"] === "1";

test("an async open failure with no error listener ends the process", async () => {
  const outDir = mkdtempSync(join(tmpdir(), "scriptc-utf8-unhandled-"));
  try {
    const entry = join(outDir, "main.mjs");
    writeFileSync(
      entry,
      `import fs from "node:fs";
import { join } from "node:path";

const stream = new fs.Utf8Stream({ dest: join(${JSON.stringify(outDir)}, "missing", "x.log") });
console.log("constructed", stream.fd);
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

    const ran = spawnSync(result.binaryPath, [], { encoding: "utf8", timeout: 20000 });
    expect(ran.signal).toBeNull();
    expect(ran.status).not.toBe(0);
    expect(ran.stdout).toBe("constructed -1\n");
    expect(ran.stderr).toContain("ENOENT");
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});
