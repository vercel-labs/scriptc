/* IncomingMessage.signal's abort listeners: a request owns its signal, and a
 * listener usually captures the request (often the response too), so the
 * listener list is a reference cycle the runtime's counts cannot collect.
 * The request's close releases the listeners; a long run of completed
 * requests then keeps its resident set flat instead of growing with every
 * hop. The sanitized lane's quarantine makes the resident set meaningless,
 * so the bound is checked in the plain lane only. */
import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const exec = promisify(execFile);
const repoRoot = join(import.meta.dirname, "../..");
const outDir = join(repoRoot, "node_modules/.cache/scriptc-tests/http-signal-memory");
const sanitize = process.env["SCRIPTC_SAN"] === "1";

test.skipIf(sanitize)(
  "completed requests release the abort listeners their signals collected",
  { timeout: 600_000 },
  async () => {
    mkdirSync(outDir, { recursive: true });
    const result = await compile(join(repoRoot, "tests/fixtures/http-signal-memory/main.ts"), {
      backend: "llvm",
      outDir,
      outPath: join(outDir, "signal-memory"),
    });
    expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true);
    if (!result.ok) return;
    const run = async (requests: number): Promise<number> => {
      const { stdout } = await exec(result.binaryPath, [String(requests)], {
        cwd: repoRoot,
        timeout: 300_000,
      });
      expect(stdout).toContain(`requests ${requests}`);
      const line = /grown (\d+)/.exec(stdout);
      expect(line).not.toBeNull();
      return Number(line![1]);
    };
    const small = await run(2_000);
    const large = await run(20_000);
    // Ten times the requests must not cost ten times the memory.
    expect(large).toBeLessThan(small + 8 * 1024 * 1024);
    expect(large).toBeLessThan(16 * 1024 * 1024);
  },
);
