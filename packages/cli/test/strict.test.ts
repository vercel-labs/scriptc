import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

async function run(argv: string[], cacheRoot: string, cwd?: string): Promise<Result> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, argv, {
      env: { ...process.env, SCRIPTC_CACHE_DIR: cacheRoot },
      ...(cwd === undefined ? {} : { cwd }),
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

/** The launcher's fast path, from `cwd` so the nearest package.json applies. */
const launcherCli = (args: string[], cacheRoot: string, cwd: string): Promise<Result> =>
  run([launcher, ...args], cacheRoot, cwd);

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
        "function total(items) { // scriptc-allow SC6101 SC6107\n" +
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
    // A cold dynamic function is a strict error too (SC6107): this fixture
    // reads untyped values once, which the ordinary build does not name.
    const cold = await cli(["coverage", quietFixture, "--strict"], cache);
    expect(cold.code).toBe(1);
    expect(cold.stdout).toContain("SC6107");
    const clean = join(dir, "clean.ts");
    await writeFile(clean, "const total: number = 2;\nconsole.log(total);\n");
    expect((await cli(["coverage", clean, "--strict"], cache)).code).toBe(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 300_000);

test("strict mode names every dynamic-tier function, cold code included, and one function can opt out", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-strict-cold-"));
  try {
    const cold = `function read(value: any): number { return value.count; }
console.log(read({ count: 1 }));
`;
    const entry = join(dir, "cold.ts");
    await writeFile(entry, cold);
    const cache = join(dir, "cache");
    const strict = await cli(["coverage", entry, "--strict"], cache);
    expect(strict.code).toBe(1);
    expect(strict.stdout).toContain("SC6107");
    expect(strict.stdout).toContain("read");
    // The allow comment on the function's own line exempts that function.
    const allowed = join(dir, "allowed.ts");
    await writeFile(
      allowed,
      cold.replace(
        "function read(value: any): number { return value.count; }",
        "function read(value: any): number { return value.count; } // scriptc-allow SC6107",
      ),
    );
    const ok = await cli(["coverage", allowed, "--strict"], join(dir, "allowed-cache"));
    expect(ok.code).toBe(0);
    // An ordinary build neither reports the finding nor names its code.
    const build = await cli(
      ["build", entry, "-o", join(dir, "cold-program")],
      join(dir, "build-cache"),
    );
    expect(build.code).toBe(0);
    expect(build.stderr).not.toContain("SC6107");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 300_000);

test("a cached strict build honours an opt-out in a file other than the finding's first", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-strict-cold-cached-"));
  try {
    await writeFile(
      join(dir, "one.ts"),
      `export function one(values: any[]): number {
  let total = 0;
  for (const v of values) total += v;
  return total;
}
`,
    );
    await writeFile(
      join(dir, "two.ts"),
      `export function two(values: any[]): number { // scriptc-allow SC6101 SC6107
  let total = 0;
  for (const v of values) total += v;
  return total;
}
`,
    );
    await writeFile(
      join(dir, "main.ts"),
      'import { one } from "./one.js";\nimport { two } from "./two.js";\nconsole.log(one([1, 2]), two([3, 4]));\n',
    );
    const cache = join(dir, "cache");
    const entry = join(dir, "main.ts");
    const outPath = join(dir, "app");
    const first = await cli(["build", entry, "-o", outPath, "--strict"], cache);
    expect(first.code).toBe(1);
    expect(first.stderr).toContain("  one (");
    expect(first.stderr).not.toContain("  two (");
    const replay = await run([launcher, "build", entry, "-o", outPath, "--strict"], cache);
    expect(replay.code).toBe(1);
    expect(replay.stderr).toContain("  one (");
    expect(replay.stderr).not.toContain("  two (");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 300_000);

test("strict mode applies to untyped package code the program compiles", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-strict-package-"));
  try {
    const pkg = join(dir, "node_modules", "untyped-kit");
    await mkdir(pkg, { recursive: true });
    await writeFile(
      join(pkg, "package.json"),
      '{"name":"untyped-kit","version":"1.0.0","type":"module","main":"index.js"}',
    );
    await writeFile(join(pkg, "index.js"), "export function wrap(value) { return { value }; }\n");
    // The declarations let the program typecheck; the package's own code
    // stays untyped JavaScript, which strict mode names.
    await writeFile(
      join(pkg, "index.d.ts"),
      "export declare function wrap(value: any): { value: any };\n",
    );
    await writeFile(
      join(dir, "main.ts"),
      'import { wrap } from "untyped-kit";\nconsole.log(wrap(1).value);\n',
    );
    const cache = join(dir, "cache");
    const strict = await launcherCli(["coverage", "main.ts", "--strict"], cache, dir);
    expect(strict.code).toBe(1);
    expect(strict.stdout).toContain("SC6107");
    expect(strict.stdout).toContain("untyped-kit");
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

test("a cached replay takes strict from the nearest package.json only", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-strict-nearest-"));
  try {
    const app = join(dir, "app");
    await mkdir(app, { recursive: true });
    // The ancestor enables strict; the nearest manifest has no scriptc key,
    // so the project it names is not strict.
    await writeFile(join(dir, "package.json"), '{"scriptc":{"strict":true}}');
    await writeFile(join(app, "package.json"), '{"name":"app"}');
    await writeFile(join(app, "hot.js"), await readFile(hotFixture, "utf8"));
    const cache = join(dir, "cache");
    const first = await launcherCli(["coverage", "hot.js"], cache, app);
    expect(first.code).toBe(0);
    expect(first.stdout).not.toContain("blockers:");
    const second = await launcherCli(["coverage", "hot.js"], cache, app);
    expect(second.code).toBe(0);
    expect(second.stdout).not.toContain("blockers:");
    expect(second.stdout).toContain("untyped and likely hot");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 300_000);

test("a cached coverage --strict keeps the promoted errors and the exit code", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-strict-cached-"));
  try {
    await writeFile(join(dir, "hot.js"), await readFile(hotFixture, "utf8"));
    const cache = join(dir, "cache");
    const first = await launcherCli(["coverage", "hot.js", "--strict"], cache, dir);
    expect(first.code).toBe(1);
    expect(first.stdout).toContain("blockers:");
    expect(first.stdout).toContain("SC6101");
    const replay = await launcherCli(["coverage", "hot.js", "--strict"], cache, dir);
    expect(replay.code).toBe(1);
    expect(replay.stdout).toContain("blockers:");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 300_000);

test("a cached replay refuses a suppression flag under the project's strict setting", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-strict-cached-flag-"));
  try {
    await writeFile(join(dir, "package.json"), '{"name":"app","scriptc":{"strict":true}}');
    await writeFile(join(dir, "hot.js"), await readFile(hotFixture, "utf8"));
    const cache = join(dir, "cache");
    expect((await launcherCli(["coverage", "hot.js"], cache, dir)).code).toBe(1);
    const refused = await launcherCli(
      ["coverage", "hot.js", "--no-dynamic-tier-warning"],
      cache,
      dir,
    );
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain(
      "--strict checks the warning --no-dynamic-tier-warning leaves out",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 300_000);

test("coverage --strict fails on a marked user module island, also from the cache", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-strict-user-module-"));
  try {
    await writeFile(
      join(dir, "package.json"),
      '{"name":"app","type":"module","scriptc":{"nodeIslands":{"modules":["plugin.js"]}}}',
    );
    await writeFile(
      join(dir, "main.ts"),
      'import { value } from "./plugin.js";\nconsole.log(value);\n',
    );
    await writeFile(join(dir, "plugin.js"), "export const value = 21 * 2;\n");
    const cache = join(dir, "cache");
    const first = await launcherCli(["coverage", "main.ts", "--strict"], cache, dir);
    expect(first.code).toBe(1);
    expect(first.stdout).toContain("SC8001");
    expect(first.stdout).toContain("user module");
    const replay = await launcherCli(["coverage", "main.ts", "--strict"], cache, dir);
    expect(replay.code).toBe(1);
    expect(replay.stdout).toContain("SC8001");

    // An allow comment on the island module's own line opts it out.
    await writeFile(
      join(dir, "plugin.js"),
      "// scriptc-allow SC8001\nexport const value = 21 * 2;\n",
    );
    const allowed = await launcherCli(
      ["coverage", "main.ts", "--strict"],
      join(dir, "ok-cache"),
      dir,
    );
    expect(allowed.code).toBe(0);
    expect(allowed.stdout).toContain("Node islands");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 300_000);

test("an allow comment on one hot function leaves the others strict errors", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-strict-per-function-"));
  try {
    const original = await readFile(hotFixture, "utf8");
    // The fixture is untyped JavaScript, so its own top level is a strict
    // finding too: the comment on line 1 opts the top level out.
    const withAllows = (names: readonly string[]): string =>
      "// scriptc-allow SC6101 SC6107\n" +
      original
        .split("\n")
        .map((line) =>
          names.some((name) => line.includes(`function ${name}(`))
            ? `${line} // scriptc-allow SC6101 SC6107`
            : line,
        )
        .join("\n");
    const entry = join(dir, "hot.js");
    await writeFile(entry, withAllows(["centroid"]));
    const cache = join(dir, "cache");
    const partial = await launcherCli(["coverage", "hot.js", "--strict"], cache, dir);
    expect(partial.code).toBe(1);
    expect(partial.stdout).toContain("spread (");
    expect(partial.stdout).not.toContain("centroid (");

    await writeFile(entry, withAllows(["scale", "centroid", "spread", "distance"]));
    const all = await launcherCli(["coverage", "hot.js", "--strict"], join(dir, "all-cache"), dir);
    expect(all.code).toBe(0);
    expect(all.stdout).toContain("untyped and likely hot");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 300_000);
