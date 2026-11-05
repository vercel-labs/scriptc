import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const repoRoot = join(import.meta.dirname, "../../..");
const cliEntry = join(repoRoot, "packages/cli/src/main.ts");
const bootstrapEntry = join(repoRoot, "packages/cli/dist/bootstrap.js");
const tsxLoader = join(dirname(require.resolve("tsx/package.json")), "dist/loader.mjs");

// A recursion that a throw below it crosses: with --exceptions=rare, walk
// calls itself with invoke.
const program = `function leaf(n: number): number {
  if (n % 7 === 0) throw new RangeError("seven " + n);
  return n;
}
function walk(n: number, depth: number): number {
  const parts: string[] = ["w" + n];
  const r = depth === 0 ? leaf(n) : walk(n, depth - 1);
  return r + parts.length;
}
let sum = 0;
for (let i = 1; i < 40; i++) {
  try { sum += walk(i, 20); } catch (e) { console.log((e as Error).message); }
}
console.log(sum);
`;

test.runIf(process.platform === "linux")(
  "--exceptions=rare unwinds through recursive functions without mixing cache variants",
  async () => {
    const dir = await mkdtemp(join("/tmp", "scriptc-exceptions-"));
    const entry = join(dir, "main.ts");
    const outPath = join(dir, "program");
    const llvmPath = join(dir, "main.ll");
    const env = { ...process.env, SCRIPTC_CACHE_DIR: join(dir, "cache") };
    const build = async (args: string[], bootstrap = false): Promise<string> => {
      await execFileAsync(
        process.execPath,
        [
          ...(bootstrap ? [bootstrapEntry] : ["--import", tsxLoader, cliEntry]),
          "build",
          entry,
          "-o",
          outPath,
          ...args,
        ],
        { env, maxBuffer: 4 * 1024 * 1024 },
      );
      return readFile(llvmPath, "utf8");
    };
    const walkInvokes = (llvm: string): boolean =>
      /^define internal [^\n]*@sc_b?f_walk\([^]*?invoke double @sc_b?f_walk[^]*?^}/m.test(llvm);
    try {
      await writeFile(entry, program);
      const expected = `${(await execFileAsync(process.execPath, [entry])).stdout}`;
      const common = await build([]);
      expect(walkInvokes(common)).toBe(false);
      expect(await build(["--exceptions=common"])).toBe(common);
      const rare = await build(["--exceptions=rare"]);
      expect(walkInvokes(rare)).toBe(true);
      expect((await execFileAsync(outPath)).stdout).toBe(expected);
      // The bootstrap's cached route builds with the default rules.
      expect(await build([], true)).toBe(common);
      expect((await execFileAsync(outPath)).stdout).toBe(expected);
      await expect(build(["--exceptions=never"])).rejects.toThrow(
        /unknown exception frequency "never"/,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
  240_000,
);

test("--exceptions is a build/run option", async () => {
  const dir = await mkdtemp(join("/tmp", "scriptc-exceptions-coverage-"));
  const entry = join(dir, "main.ts");
  try {
    await writeFile(entry, program);
    const coverage = execFileAsync(
      process.execPath,
      ["--import", tsxLoader, cliEntry, "coverage", entry, "--exceptions=rare"],
      { env: { ...process.env, SCRIPTC_CACHE_DIR: join(dir, "cache") } },
    );
    await expect(coverage).rejects.toThrow(/--exceptions is a build\/run option/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 120_000);
