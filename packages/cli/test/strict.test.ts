import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const repoRoot = join(import.meta.dirname, "../../..");
const cliEntry = join(repoRoot, "packages/cli/src/main.ts");
const launcher = join(repoRoot, "packages/cli/dist/bootstrap.js");
const tsxLoader = join(dirname(require.resolve("tsx/package.json")), "dist/loader.mjs");
const widthFixture = join(repoRoot, "tests/coverage-fixtures/width-copies.ts");
const hotFixture = join(repoRoot, "tests/coverage-fixtures/dynamic-tier/hot.js");
const quietFixture = join(repoRoot, "tests/coverage-fixtures/dynamic-tier/quiet.ts");

type Result = { code: number; stdout: string; stderr: string };

async function run(argv: string[], cacheRoot: string): Promise<Result> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, argv, {
      env: { ...process.env, SCRIPTC_CACHE_DIR: cacheRoot },
      maxBuffer: 4 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

const cli = (args: string[], cacheRoot: string): Promise<Result> =>
  run(["--import", tsxLoader, cliEntry, ...args], cacheRoot);

const COPY = `interface Narrow { a: number }
interface Wide { a: number; b: string }
const wide: Wide = { a: 1, b: "x" };
const narrow: Narrow = wide;
narrow.a = 2;
console.log(wide.a);
`;

test("coverage --strict turns a performance hint into an error, and an allow comment opts the line out", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-strict-coverage-"));
  try {
    await mkdir(join(dir, "cache"), { mode: 0o700 });
    const cache = join(dir, "cache");
    expect((await cli(["coverage", hotFixture], cache)).code).toBe(0);
    const strict = await cli(["coverage", hotFixture, "--strict"], cache);
    expect(strict.code).toBe(1);
    expect(strict.stdout).toContain("blockers:");
    expect(strict.stdout).toContain("SC6101");

    // A line with the allow comment keeps the hint as a warning.
    const allowed = join(dir, "allowed.js");
    await writeFile(
      allowed,
      'const events = JSON.parse(process.argv[2] ?? "[]");\n' +
        "function total(items) { // scriptc-allow SC6101\n" +
        "  let sum = 0;\n" +
        "  for (let i = 0; i < items.length; i++) sum += items[i].n;\n" +
        "  return sum;\n" +
        "}\n" +
        "console.log(total(events));\n",
    );
    const passed = await cli(["coverage", allowed, "--strict"], join(dir, "allowed-cache"));
    expect(passed.code).toBe(0);
    expect(passed.stdout).toContain("untyped and likely hot");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 300_000);

test("coverage --strict fails on conversion copies, and the project setting turns it on", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-strict-copy-"));
  try {
    const strict = await cli(["coverage", widthFixture, "--strict"], join(dir, "cache"));
    expect(strict.code).toBe(1);
    expect(strict.stdout).toContain("blockers:");
    expect(strict.stdout).toContain("SC6001");

    const project = join(dir, "project");
    await mkdir(project, { recursive: true });
    await writeFile(join(project, "main.ts"), COPY);
    await writeFile(
      join(project, "package.json"),
      '{"name":"strict-app","scriptc":{"strict":true}}',
    );
    const configured = await cli(["coverage", join(project, "main.ts")], join(dir, "cfg-cache"));
    expect(configured.code).toBe(1);
    expect(configured.stdout).toContain("SC6001");

    await writeFile(
      join(project, "package.json"),
      '{"name":"strict-app","scriptc":{"strict":false}}',
    );
    const off = await cli(["coverage", join(project, "main.ts")], join(dir, "off-cache"));
    expect(off.code).toBe(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 300_000);

test("coverage --strict refuses the flags that hide what it checks, and a clean program passes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-strict-flags-"));
  try {
    const cache = join(dir, "cache");
    const copy = await cli(["coverage", widthFixture, "--strict", "--no-copy-warning"], cache);
    expect(copy.code).toBe(1);
    expect(copy.stderr).toContain("--strict checks the warning --no-copy-warning leaves out");
    const dynamic = await cli(
      ["coverage", hotFixture, "--strict", "--no-dynamic-tier-warning"],
      cache,
    );
    expect(dynamic.code).toBe(1);
    expect(dynamic.stderr).toContain(
      "--strict checks the warning --no-dynamic-tier-warning leaves out",
    );
    expect((await cli(["coverage", quietFixture, "--strict"], cache)).code).toBe(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 300_000);

test("build --strict fails on a copy, accepts an allow comment, and a cached build fails the same way", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-strict-build-"));
  try {
    const entry = join(dir, "main.ts");
    await writeFile(entry, COPY);
    const cache = join(dir, "cache");
    const outPath = join(dir, process.platform === "win32" ? "program.exe" : "program");
    const built = await cli(["build", entry, "-o", outPath, "--strict"], cache);
    expect(built.code).toBe(1);
    expect(built.stderr).toContain("error SC6001");
    expect(built.stderr).toContain("strict mode requires optimal code");

    // The same program with the allow comment compiles and reports a warning.
    const allowed = join(dir, "allowed.ts");
    await writeFile(
      allowed,
      COPY.replace(
        "const narrow: Narrow = wide;",
        "const narrow: Narrow = wide; // scriptc-allow SC6001",
      ),
    );
    const ok = await cli(["build", allowed, "-o", join(dir, "ok-program")], join(dir, "ok-cache"));
    expect(ok.code).toBe(0);
    expect(ok.stderr).toContain("warning SC6001");

    // A cache filled by an ordinary build is replayed as an error under --strict.
    expect((await cli(["build", entry, "-o", outPath], cache)).code).toBe(0);
    const replay = await run([launcher, "build", entry, "-o", outPath, "--strict"], cache);
    expect(replay.code).toBe(1);
    expect(replay.stderr).toContain("error SC6001");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 300_000);
