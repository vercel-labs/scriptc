import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { hostTargetCpu } from "../../compiler/src/backend/target-cpu.js";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const repoRoot = join(import.meta.dirname, "../../..");
const cliEntry = join(repoRoot, "packages/cli/src/main.ts");
const bootstrapEntry = join(repoRoot, "packages/cli/dist/bootstrap.js");
const tsxLoader = join(dirname(require.resolve("tsx/package.json")), "dist/loader.mjs");
const host = hostTargetCpu();
const runsV3 = host === "x86-64-v3" || host === "x86-64-v4";

const program = `const a = new Int32Array(4096);
for (let i = 0; i < a.length; i++) a[i] = (i * 2654435761) | 0;
let s = 0;
for (let r = 0; r < 64; r++) for (let i = 0; i < a.length; i++) s = (s + a[i]!) | 0;
console.log(s);
`;

test.runIf(process.platform === "linux" && process.arch === "x64")(
  "--target-cpu compiles the program for the level without mixing cache variants",
  async () => {
    const dir = await mkdtemp(join("/tmp", "scriptc-target-cpu-"));
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
    try {
      await writeFile(entry, program);
      const expected = `${(await execFileAsync(process.execPath, [entry])).stdout}`;
      const baseline = await build([]);
      expect(baseline).not.toContain('"target-cpu"');
      // Only --sanitize builds mark the functions for ASan instrumentation.
      expect(baseline).not.toContain("sanitize_address");
      expect(await build(["--target-cpu=baseline"])).toBe(baseline);
      const v3 = await build(["--target-cpu=x86-64-v3"]);
      expect(v3).toMatch(/^attributes #0 = \{ uwtable "target-cpu"="x86-64-v3" \}$/m);
      if (runsV3) expect((await execFileAsync(outPath)).stdout).toBe(expected);
      // The bootstrap's cached route builds without a level.
      expect(await build([], true)).toBe(baseline);
      expect((await execFileAsync(outPath)).stdout).toBe(expected);
      await expect(build(["--target-cpu=haswell"])).rejects.toThrow(/unknown target CPU "haswell"/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
  240_000,
);

test("--target-cpu levels are refused for arm64 and WASI targets", async () => {
  const dir = await mkdtemp(join("/tmp", "scriptc-target-cpu-refusal-"));
  const entry = join(dir, "main.ts");
  try {
    await writeFile(entry, program);
    for (const target of ["aarch64-unknown-linux-gnu", "wasm32-wasi"]) {
      for (const kind of ["llvm", "asm", "obj", "exe"]) {
        const build = execFileAsync(
          process.execPath,
          [
            "--import",
            tsxLoader,
            cliEntry,
            "build",
            entry,
            `--emit=${kind}`,
            "-o",
            join(dir, `out-${kind}`),
            "--target-cpu=x86-64-v3",
          ],
          {
            env: { ...process.env, SCRIPTC_TARGET: target, SCRIPTC_CACHE_DIR: join(dir, "cache") },
          },
        );
        await expect(build, `${target} ${kind}`).rejects.toThrow(
          /--target-cpu=x86-64-v3 requires an x86-64 target/,
        );
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 240_000);
