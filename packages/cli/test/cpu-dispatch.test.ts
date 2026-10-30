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

const program = `function mix(a: Float64Array, b: Float64Array, k: number): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * k + b[i]! / (i + 1);
  return s;
}
const a = new Float64Array(4096);
const b = new Float64Array(4096);
for (let i = 0; i < a.length; i++) {
  a[i] = ((i * 7919) % 1000) / 7 - 50;
  b[i] = 1 / (i + 3);
}
let total = 0;
for (let r = 0; r < 32; r++) total += mix(a, b, r * 0.1);
console.log(total, [3, 1, 2].map((x) => mix(a.subarray(x), b, x)).join(" "));
`;

test.runIf(process.platform === "linux" && process.arch === "x64")(
  "--cpu-dispatch builds one executable that matches Node at every level",
  async () => {
    const dir = await mkdtemp(join("/tmp", "scriptc-cpu-dispatch-"));
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
    const run = async (level?: string): Promise<string> =>
      (
        await execFileAsync(outPath, [], {
          env: { ...process.env, ...(level === undefined ? {} : { SCRIPTC_CPU_LEVEL: level }) },
        })
      ).stdout;
    try {
      await writeFile(entry, program);
      const expected = `${(await execFileAsync(process.execPath, [entry])).stdout}`;
      const plain = await build(["--optimization=speed"]);
      expect(plain).not.toContain("@sc_cpu_level");
      const dispatching = await build(["--optimization=speed", "--cpu-dispatch"]);
      expect(dispatching).toMatch(/^define internal double @sc_bf_mix\.v3\(/m);
      for (const level of [undefined, "0", "baseline", "3", "x86-64-v3"])
        expect(await run(level), `SCRIPTC_CPU_LEVEL=${level}`).toBe(expected);
      // The bootstrap's cached route keeps the two builds apart.
      expect(await build(["--optimization=speed"], true)).toBe(plain);
      expect(await build(["--optimization=speed", "--cpu-dispatch"], true)).toBe(dispatching);
      expect(await build(["--cpu-dispatch"])).toContain("@sc_cpu_level_init()");
      expect(await run("0")).toBe(expected);
      expect(await build(["--target-cpu=x86-64-v3", "--cpu-dispatch"])).not.toContain(
        "@sc_cpu_level",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
  240_000,
);
