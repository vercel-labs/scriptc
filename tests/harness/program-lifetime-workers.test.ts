/* ProgramLifetime instances that a worker creates are never freed while it
 * runs, but on Linux they go back with the rest of its memory when it exits
 * without sharing anything. The corpus program pins Node.js parity; this
 * suite runs it with the allocator's statistics (SCR_SA_STATS=1) and checks
 * that each discarded worker returned its program-lifetime objects. Under
 * SCRIPTC_SAN=1 the runtime keeps every worker's memory, so the check does
 * not apply. */
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const exec = promisify(execFile);
const program = join(import.meta.dirname, "../corpus/4637-contract-program-lifetime-workers.ts");
const sanitize = process.env["SCRIPTC_SAN"] === "1";

test.skipIf(process.platform !== "linux" || sanitize)(
  "workers that exit without sharing return their ProgramLifetime instances",
  { timeout: 240_000 },
  async () => {
    const outDir = await mkdtemp(join(tmpdir(), "scriptc-program-lifetime-workers-"));
    try {
      const result = await compile(program, {
        backend: "llvm",
        outDir,
        outPath: join(outDir, "program"),
      });
      expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true);
      if (!result.ok) return;
      const { stdout, stderr } = await exec(result.binaryPath, [], {
        env: { ...process.env, SCR_SA_STATS: "1", SCR_SA_DISCARD_DELAY_MS: "0" },
        timeout: 120_000,
      });
      expect(stdout).toContain("wave 2: ");
      // One line per discarded worker; each built 200,000 items in 50 groups.
      const returned = [...stderr.matchAll(/(\d+) MB of program-lifetime objects/g)].map((m) =>
        Number(m[1]),
      );
      expect(returned.length).toBeGreaterThan(0);
      for (const mb of returned) expect(mb).toBeGreaterThanOrEqual(4);
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  },
);
