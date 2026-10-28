import { execFile, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const repoRoot = join(import.meta.dirname, "../../..");
const cliEntry = join(repoRoot, "packages/cli/src/main.ts");
const tsxLoader = join(dirname(require.resolve("tsx/package.json")), "dist/loader.mjs");

const PROGRAM = `const n = Number(process.argv[2] ?? "10");
let total = 0;
for (let i = 0; i < n; i++) total += i % 3 === 0 ? i : 1;
console.log(\`total \${total}\`);
if (process.argv[3] === "exit") process.exit(3);
// Never runs in the profiled runs.
function depth(k: number): number {
  return k <= 0 ? 0 : 1 + depth(k - 1);
}
if (process.argv[3] === "depth") console.log(depth(n));
`;

async function scriptc(args: string[], env: NodeJS.ProcessEnv) {
  return execFileAsync(process.execPath, ["--import", tsxLoader, cliEntry, ...args], {
    env,
    maxBuffer: 4 * 1024 * 1024,
  });
}

test.skipIf(process.platform !== "linux" && process.platform !== "darwin")(
  "instrumented runs write profiles that merge and optimize the program, stale or not",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "scriptc-profile-"));
    const env = { ...process.env, SCRIPTC_CACHE_DIR: join(dir, "cache") };
    const entry = join(dir, "main.ts");
    const raw = join(dir, "raw");
    try {
      await writeFile(entry, PROGRAM);
      const instrumented = join(dir, "instrumented");
      await scriptc(
        ["build", entry, "--profile-generate", join(raw, "%p.profraw"), "-o", instrumented],
        env,
      );
      expect((await execFileAsync(instrumented, ["1000"])).stdout).toBe("total 167499\n");
      // process.exit leaves through _Exit, which skips the profile runtime's
      // atexit writer; the runtime writes the profile itself.
      await expect(execFileAsync(instrumented, ["1000", "exit"])).rejects.toMatchObject({
        code: 3,
        stdout: "total 167499\n",
      });
      const profiles = (await readdir(raw)).filter((name) => name.endsWith(".profraw"));
      expect(profiles).toHaveLength(2);

      const merged = join(dir, "app.profdata");
      const merge = await scriptc(
        ["merge-profiles", "-o", merged, ...profiles.map((name) => join(raw, name))],
        env,
      );
      expect(merge.stdout).toBe(`${merged}\n`);

      const optimized = join(dir, "optimized");
      await scriptc(["build", entry, "--profile-use", merged, "-o", optimized], env);
      expect((await execFileAsync(optimized, ["1000"])).stdout).toBe("total 167499\n");

      // A sparse profile leaves out the runtime functions the runs never
      // reached.
      const sparse = join(dir, "sparse.profdata");
      await scriptc(
        ["merge-profiles", "--sparse", "-o", sparse, ...profiles.map((name) => join(raw, name))],
        env,
      );
      expect((await stat(sparse)).size).toBeLessThan((await stat(merged)).size);
      await scriptc(["build", entry, "--profile-use", sparse, "-o", optimized], env);
      expect((await execFileAsync(optimized, ["1000"])).stdout).toBe("total 167499\n");

      // A profile from an older version of the program still builds it.
      await writeFile(entry, PROGRAM + 'console.log("edited");\n');
      await scriptc(["build", entry, "--profile-use", merged, "-o", optimized], env);
      expect((await execFileAsync(optimized, ["1000"])).stdout).toBe("total 167499\nedited\n");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
  300_000,
);

const SERVER = `let ticks = 0;
setInterval(() => {
  ticks += JSON.stringify({ ticks }).length;
}, 5);
console.log("ready");
`;

test.skipIf(process.platform !== "linux" && process.platform !== "darwin")(
  "an instrumented program stopped by a termination signal still writes its profile",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "scriptc-profile-signal-"));
    const env = { ...process.env, SCRIPTC_CACHE_DIR: join(dir, "cache") };
    const entry = join(dir, "server.ts");
    const raw = join(dir, "raw");
    try {
      await writeFile(entry, SERVER);
      const instrumented = join(dir, "instrumented");
      await scriptc(
        ["build", entry, "--profile-generate", join(raw, "%p.profraw"), "-o", instrumented],
        env,
      );
      const child = spawn(instrumented, [], { stdio: ["ignore", "pipe", "inherit"] });
      await new Promise<void>((resolve) =>
        child.stdout.on("data", (chunk: Buffer) => {
          if (chunk.toString().includes("ready")) resolve();
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
      const exited = new Promise<NodeJS.Signals | null>((resolve) =>
        child.on("exit", (_code, signal) => resolve(signal)),
      );
      child.kill("SIGTERM");
      // The signal still ends the process, after the profile is written.
      expect(await exited).toBe("SIGTERM");
      const profiles = (await readdir(raw)).filter((name) => name.endsWith(".profraw"));
      expect(profiles).toHaveLength(1);
      expect((await stat(join(raw, profiles[0]!))).size).toBeGreaterThan(0);
      const merged = join(dir, "server.profdata");
      await scriptc(["merge-profiles", "-o", merged, join(raw, profiles[0]!)], env);
      const optimized = join(dir, "optimized");
      await scriptc(["build", entry, "--profile-use", merged, "-o", optimized], env);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
  300_000,
);

test("profile options are refused where they cannot apply", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-profile-refusal-"));
  const env = { ...process.env, SCRIPTC_CACHE_DIR: join(dir, "cache") };
  const entry = join(dir, "main.ts");
  try {
    await writeFile(entry, PROGRAM);
    for (const [args, message] of [
      [["build", entry, "--emit=llvm", "--profile-use", "a.profdata"], "--emit=exe"],
      [
        ["build", entry, "--profile-generate", "%p.profraw", "--profile-use", "a.profdata"],
        "cannot be combined",
      ],
      [["coverage", entry, "--profile-use", "a.profdata"], "build/run option"],
      [["merge-profiles", "a.profraw"], "merge-profiles takes -o"],
      [["merge-profiles", "-o", "out.profdata"], "merge-profiles takes -o"],
      [["build", entry, "--sparse"], "--sparse is a merge-profiles option"],
      [
        ["build", entry, "--optimization=dev", "--profile-use", join(dir, "a.profdata")],
        "optimized build",
      ],
      [["build", entry, "--profile-use", join(dir, "missing.profdata")], "cannot read"],
    ] as const) {
      await expect(scriptc([...args], env)).rejects.toMatchObject({
        stderr: expect.stringContaining(message),
      });
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 120_000);
