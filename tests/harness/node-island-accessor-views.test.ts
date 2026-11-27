/* A compiled class's accessor read from island code. Every read hands V8 a
 * fresh byte view, and the accessor's entry is what ends those young views
 * after it; without that entry both heaps keep every chunk the getter
 * answered, however long ago island code dropped it. The fixture prints the
 * process's peak resident set, so the two runs below differ only in the
 * growth the reads would add. Needs a libnode pack in SCRIPTC_LIBNODE
 * (libnode.ts). */
import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { beforeAll, describe, expect, test } from "vitest";
import { compile } from "@scriptc/compiler";
import { libnodePack } from "./libnode.js";

const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dirname, "../..");
const fixtures = join(repoRoot, "tests/fixtures/node-island/accessor-views");
const outDir = join(repoRoot, "node_modules/.cache/scriptc-tests/node-island-accessor-views");
const sanitize = process.env["SCRIPTC_SAN"] === "1";
const skip = libnodePack() === null;

let binary = "";

async function run(reads: number): Promise<{ stdout: string; rss: number }> {
  const { stdout, stderr } = await execFileAsync(binary, [String(reads)], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  expect(stderr).not.toMatch(/used after V8 collected|AddressSanitizer|LeakSanitizer/);
  const rss = Number(/peak rss (\d+) KiB/.exec(stderr)?.[1]);
  expect(Number.isFinite(rss), stderr).toBe(true);
  return { stdout, rss };
}

describe.skipIf(skip)("a compiled class accessor read from an island", () => {
  beforeAll(async () => {
    mkdirSync(outDir, { recursive: true });
    const result = await compile(join(fixtures, "main.mjs"), {
      outPath: join(outDir, "accessor-views"),
      outDir,
      sanitize,
    });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    binary = result.binaryPath;
  }, 300_000);

  test("the chunks a getter returns do not stay rooted as the reads grow", async () => {
    const small = await run(2_000);
    const large = await run(20_000);
    expect(small.stdout).toBe("sum 131072000 reads 2000 made 1 65536\n");
    expect(large.stdout).toBe("sum 1310720000 reads 20000 made 1 65536\n");
    // Each read hands V8 a fresh 64 KiB view. When the accessor does not end
    // the young views after it, both heaps keep every one of them and the
    // large run's peak grows by about 1.2 GiB; ending them at the accessor
    // leaves the peak as flat as the small run's. The sanitized lane keeps
    // a quarantine, so its resident set says nothing here.
    if (!sanitize) expect(large.rss).toBeLessThan(small.rss * 1.5 + 64 * 1024);
  }, 600_000);
});
