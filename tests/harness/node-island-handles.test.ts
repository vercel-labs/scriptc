/* Island object handles (scope-B NI-4) where a differential corpus program
 * cannot show it: handles to Node objects the program dropped are released,
 * so the import table does not grow with the work a program does (acyclic
 * garbage; node-island-gc.test.ts covers cycles across both heaps). The
 * corpus (6812-6815) pins handle semantics against Node. Needs a libnode
 * pack in SCRIPTC_LIBNODE (libnode.ts). */
import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import { compile } from "@scriptc/compiler";
import { libnodePack } from "./libnode.js";

const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dirname, "../..");
const outDir = join(repoRoot, "node_modules/.cache/scriptc-tests/node-island-handles");
const sanitize = process.env["SCRIPTC_SAN"] === "1";
const skip = libnodePack() === null;

describe.skipIf(skip)("Node island handles", () => {
  test("handles the program dropped are released", async () => {
    mkdirSync(outDir, { recursive: true });
    const result = await compile(join(repoRoot, "tests/fixtures/node-island/handles-leak.mjs"), {
      outPath: join(outDir, "handles-leak"),
      outDir,
      sanitize,
    });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    const env = { ...process.env, SCRIPTC_NODE_ISLANDS_TRACE: "handles" };
    const counts: number[] = [];
    for (const n of ["2000", "20000"]) {
      const { stdout, stderr } = await execFileAsync(result.binaryPath, [n], {
        env,
        encoding: "utf8",
      });
      expect(stdout).toMatch(/^sum \d+ 499500 object -1\n$/);
      const live = /\[node-islands\] live handles (\d+)/.exec(stderr);
      expect(live).not.toBeNull();
      counts.push(Number(live![1]));
    }
    // The module and the kept object (with util.inspect, at most a few
    // more), independent of the number of iterations.
    expect(counts[0]).toBe(counts[1]);
    expect(counts[1]).toBeLessThan(8);
  }, 300_000);
});
