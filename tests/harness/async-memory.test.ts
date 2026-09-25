/* Suspended async calls hold only their live state. The LLVM backend lowers
 * async bodies to heap-allocated coroutine frames instead of giving every
 * call its own fiber stack, so parking thousands of calls on one pending
 * promise must stay near Node's footprint rather than paying pages of
 * stack per call. The fixture reports its own resident growth from
 * /proc/self/status, so the check is Linux-only; ASan's shadow memory and
 * redzones make resident sizes meaningless under SCRIPTC_SAN=1. */
import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const execFileAsync = promisify(execFile);
const fixture = join(import.meta.dirname, "../fixtures/async-memory/parked.ts");
const sanitize = process.env["SCRIPTC_SAN"] === "1";

describe.skipIf(process.platform !== "linux" || sanitize)("suspended async memory", () => {
  test("20k calls parked on one promise stay under 1 KiB each", async () => {
    const outDir = await mkdtemp("/tmp/scriptc-async-memory-");
    const result = await compile(fixture, { outPath: join(outDir, "parked"), outDir, backend: "llvm" });
    if (!result.ok) {
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    }
    const calls = 20000;
    const { stdout } = await execFileAsync(result.binaryPath, [String(calls)]);
    const [count, total, grownKiB] = stdout.trim().split(" ").map(Number) as [number, number, number];
    expect(count).toBe(calls);
    expect(total).toBe(188890);
    expect(grownKiB / calls).toBeLessThan(1);
  }, 120_000);
});
