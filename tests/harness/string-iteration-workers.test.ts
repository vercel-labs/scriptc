/* The one-character strings that string iteration shares between threads
 * outlive the worker that first made them. On Linux a worker that exits
 * without sharing anything returns its memory; with SCR_SA_DISCARD=poison
 * that memory becomes inaccessible instead, so a cached character
 * allocated from the worker's memory would fault when the main thread
 * reads it. The corpus program pins Node.js parity; this suite runs it
 * with the discard poisoned and immediate. Under SCRIPTC_SAN=1 the runtime
 * keeps every worker's memory, so the check does not apply. */
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const exec = promisify(execFile);
const program = join(import.meta.dirname, "../corpus/8348-string-iteration-worker-characters.ts");
const sanitize = process.env["SCRIPTC_SAN"] === "1";

test.skipIf(process.platform !== "linux" || sanitize)(
  "characters a discarded worker cached stay readable",
  { timeout: 240_000 },
  async () => {
    const outDir = await mkdtemp(join(tmpdir(), "scriptc-string-iteration-workers-"));
    try {
      const result = await compile(program, {
        backend: "llvm",
        outDir,
        outPath: join(outDir, "program"),
      });
      expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true);
      if (!result.ok) return;
      const { stdout } = await exec(result.binaryPath, [], {
        env: { ...process.env, SCR_SA_DISCARD: "poison", SCR_SA_DISCARD_DELAY_MS: "0" },
        timeout: 120_000,
      });
      expect(stdout).toContain("main 1:61 1:e9 1:20 1:f1");
      expect(stdout).toContain("spread a|é| |ñ");
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  },
);
