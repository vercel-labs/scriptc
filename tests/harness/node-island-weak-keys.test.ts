/* Native weak collections keyed by objects a Node island made, where a
 * differential corpus program cannot show it (a corpus program cannot
 * force a collection). tests/fixtures/node-island/weak-keys.mjs enters a
 * new island object into a WeakMap, a WeakSet and a FinalizationRegistry
 * per iteration and drops it; the corpus (8754, 8850) pins identity and
 * the values against Node.
 *  - An entry does not keep its key alive and goes when the key does: the
 *    memory, the handles and the exports a program holds do not grow with
 *    the number of keys it dropped (800k against 1.6M iterations), and no
 *    dropped key the island watches is alive at the end, the ones whose
 *    value reaches the key through either heap included.
 *  - An entry stays while either side reaches its key: keys the program
 *    keeps, and keys only the island keeps and hands back at the end, find
 *    their entries, with forced full collections throughout (and, in the
 *    sanitized lane, under ASan) as with the cross-heap collector off.
 *  - A value goes at once when the program deletes or replaces its entry
 *    (tests/fixtures/node-island/weak-keys-values.mjs): 2,000 buffers of
 *    256 KiB, one live at a time, with nothing in the island that would
 *    make V8 collect.
 * Needs a libnode pack in SCRIPTC_LIBNODE (libnode.ts). */
import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { beforeAll, describe, expect, test } from "vitest";
import { compile } from "@scriptc/compiler";
import { libnodePack } from "./libnode.js";

const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dirname, "../..");
const fixtures = join(repoRoot, "tests/fixtures/node-island");
const outDir = join(repoRoot, "node_modules/.cache/scriptc-tests/node-island-weak-keys");
const sanitize = process.env["SCRIPTC_SAN"] === "1";
const skip = libnodePack() === null;

interface Run {
  stdout: string;
  totals: Record<string, number>;
  rss: number;
}

let binary = "";

async function run(args: string[], env: Record<string, string> = {}): Promise<Run> {
  const { stdout, stderr } = await execFileAsync(binary, args, {
    cwd: fixtures,
    env: { ...process.env, SCRIPTC_NODE_ISLANDS_TRACE: "gc", ...env },
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  expect(stderr).not.toMatch(/used after V8 collected|AddressSanitizer|LeakSanitizer/);
  const line = /\[node-islands\] gc totals: (.*)/.exec(stderr);
  expect(line).not.toBeNull();
  const totals: Record<string, number> = {};
  for (const m of line![1]!.matchAll(/([a-z ]+?) (\d+(?:\.\d+)?)(?: ms)?(?:,|$)/g))
    totals[m[1]!.trim()] = Number(m[2]);
  const rss = Number(/peak rss (\d+) KiB/.exec(stderr)?.[1]);
  return { stdout, totals, rss };
}

/** The fixture's first line: what every kept key answered. */
function kept(stdout: string): string {
  return stdout.slice(0, stdout.indexOf("\n"));
}

describe.skipIf(skip)("Node island objects as native weak keys", () => {
  beforeAll(async () => {
    mkdirSync(outDir, { recursive: true });
    const result = await compile(join(fixtures, "weak-keys.mjs"), {
      outPath: join(outDir, "weak-keys"),
      outDir,
      sanitize,
    });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    binary = result.binaryPath;
  }, 300_000);

  test("entries go with their keys: nothing grows with the keys dropped", async () => {
    // V8 collects on its own schedule, and the peak follows what was dropped
    // since its last collection: on a machine that lets it keep a larger heap
    // it collects less often, and the peak keeps rising with the iteration
    // count (measured: 155 MB at 800,000 and 319 MB at 1,600,000). Both runs
    // force a full collection at the same iteration interval, so the peak
    // reflects what the entries keep alive rather than how often the engine
    // collected. The sanitized lane does not compare memory (ASan's
    // quarantine decides its resident set).
    const [few, many] = sanitize ? [4_000, 40_000] : [800_000, 1_600_000];
    const cadence = sanitize ? [] : [`gc:${Math.floor(few / 40)}`];
    const small = await run([String(few), ...cadence]);
    const large = await run([String(many), ...cadence]);
    for (const r of [small, large]) {
      expect(r.stdout).toMatch(
        /^sum \d+ check \d+ kept (\d+) and (\d+)\ndropped keys alive 0 of \d+\n$/,
      );
      expect(r.totals["analyzed"]).toBe(r.totals["major"]);
    }
    // The same keys are kept and watched for both counts.
    expect(large.stdout.slice(large.stdout.indexOf(" check"))).toBe(
      small.stdout.slice(small.stdout.indexOf(" check")),
    );
    // Three values in five are native and sit in a cell the island holds
    // by reference: nearly every one was freed with its key.
    expect(large.totals["freed exports"]).toBeGreaterThan(0.99 * 0.6 * many - 1000);
    // What stays alive is what the kept keys need, the same for both.
    for (const key of ["held exports", "held handles", "representatives", "import entries"])
      expect(large.totals[key], key).toBe(small.totals[key]);
    expect(large.totals["held handles"]).toBeLessThan(200);
    // Peak memory does not grow with the keys dropped: twice the keys, and
    // 50 bytes leaked per key would be 40 MB (ASan's quarantine makes the
    // sanitized lane's resident set meaningless).
    if (!sanitize) expect(large.rss).toBeLessThan(small.rss * 1.05 + 8 * 1024);
  }, 900_000);

  test("forced collections end no entry whose key either side still reaches", async () => {
    const n = sanitize ? "2000" : "12000";
    const off = await run([n, "gc"], { SCRIPTC_NODE_ISLANDS_GC: "off" });
    const on = await run([n, "gc"]);
    expect(off.totals["analyzed"]).toBe(0);
    expect(on.totals["analyzed"]).toBe(on.totals["major"]);
    expect(on.totals["major"]).toBeGreaterThan(20);
    expect(on.stdout).toMatch(
      /^sum \d+ check \d+ kept (\d+) and (\d+)\ndropped keys alive 0 of \d+\n$/,
    );
    // With the collector off, a key a native value reaches stays alive (its
    // handle is a root): only the kept keys' answers are the same.
    expect(kept(on.stdout)).toBe(kept(off.stdout));
  }, 600_000);

  test("a deleted or replaced entry's value is released at once", async () => {
    const dir = join(outDir, "values");
    mkdirSync(dir, { recursive: true });
    const result = await compile(join(fixtures, "weak-keys-values.mjs"), {
      outPath: join(dir, "weak-keys-values"),
      outDir: dir,
      sanitize,
    });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    const n = 2000;
    const { stdout, stderr } = await execFileAsync(result.binaryPath, [String(n)], {
      cwd: fixtures,
      env: { ...process.env },
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    expect(stderr).not.toMatch(/AddressSanitizer|LeakSanitizer/);
    let sum = 0;
    for (let i = 0; i < n; i++) sum += i & 255;
    expect(stdout).toBe(`sum ${sum} entries ${n / 2} of ${n}\n`);
    // Kept until a collection, the buffers would be 500 MiB (ASan's
    // quarantine holds freed memory, so the sanitized lane has no bound).
    const rss = Number(/peak rss (\d+) KiB/.exec(stderr)?.[1]);
    if (!sanitize) expect(rss).toBeLessThan(200 * 1024);
  }, 300_000);
});
