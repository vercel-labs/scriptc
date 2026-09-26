import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const run = promisify(execFile);
const fixture = join(import.meta.dirname, "../fixtures/terminal-geometry");

test.skipIf(process.platform === "win32")("stdio geometry matches Node on independent resized PTYs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-geometry-"));
  try {
    const entry = join(fixture, "main.ts");
    const script = join(fixture, "observe.py");
    const oracle = await run("python3", [script, process.execPath, "--experimental-strip-types", entry]);
    expect(JSON.parse(oracle.stdout)).toEqual([[88, 48, 72, 30], [100, 52, 80, 24]]);
    expect(oracle.stderr).toBe("");
    for (const backend of ["c", "llvm"] as const) {
      const result = await compile(entry, { outDir: dir, outPath: join(dir, backend), backend, sanitize: process.env["SCRIPTC_SAN"] === "1" });
      if (!result.ok) throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
      const native = await run("python3", [script, result.binaryPath]);
      expect(native.stdout).toBe(oracle.stdout);
      expect(native.stderr).toBe("");
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 60_000);
