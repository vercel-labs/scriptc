import { execFile, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const repoRoot = join(import.meta.dirname, "../../..");
const cliEntry = join(repoRoot, "packages/cli/src/main.ts");
const bootstrapEntry = join(repoRoot, "packages/cli/dist/bootstrap.js");
const tsxLoader = join(dirname(require.resolve("tsx/package.json")), "dist/loader.mjs");

const HELP_POINTER = "Run 'scriptc --help' for the commands and options.\n";
const posix = process.platform !== "win32";

let dir: string;
let env: NodeJS.ProcessEnv;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "scriptc-run-arguments-"));
  await mkdir(join(dir, "cache"), { mode: 0o700 });
  env = { ...process.env, SCRIPTC_CACHE_DIR: join(dir, "cache") };
});
afterAll(() => rm(dir, { recursive: true, force: true }));

async function program(name: string, source: string): Promise<string> {
  const entry = join(dir, name);
  await writeFile(entry, source);
  return entry;
}

/** The full CLI, or the bootstrap, whose cached route runs an unchanged program without loading
 * the compiler. */
function command(bootstrap: boolean): string[] {
  return bootstrap ? [bootstrapEntry] : ["--import", tsxLoader, cliEntry];
}

async function cli(
  args: string[],
  bootstrap = false,
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [...command(bootstrap), ...args],
      { env, cwd: dir, maxBuffer: 4 * 1024 * 1024 },
    );
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number | string; stdout?: string; stderr?: string };
    if (typeof e.code !== "number") throw err;
    return { code: e.code, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

const ARGUMENT_LISTS: string[][] = [
  [],
  ["a", "b"],
  ["--", "a", "b", "--flag"],
  ["a", "b", "--flag", "--", "c"],
  // scriptc's own option spellings are the program's once they follow the entry.
  ["--strip", "-o", "elsewhere", "--help", "--version", "--optimization=dev"],
  ["with space", "ünï", "--key=value", "-"],
];

test("run passes what follows the entry to the program, as node does", async () => {
  const entry = await program("args.ts", "console.log(JSON.stringify(process.argv.slice(2)));\n");
  for (const args of ARGUMENT_LISTS) {
    const node = await execFileAsync(process.execPath, [entry, ...args], { cwd: dir });
    // The first run builds; the bootstrap then runs the cached executable.
    for (const bootstrap of [false, true]) {
      const result = await cli(["run", entry, ...args], bootstrap);
      expect(result, `${bootstrap ? "bootstrap" : "cli"} ${JSON.stringify(args)}`).toEqual({
        code: 0,
        stdout: node.stdout,
        stderr: "",
      });
    }
  }
  expect(existsSync(join(dir, "elsewhere"))).toBe(false);
}, 180_000);

test("process.argv keeps two leading entries, so arguments start at index 2 as in node", async () => {
  const entry = await program(
    "shape.ts",
    "console.log(JSON.stringify([process.argv.length, process.argv[0], process.argv[1], process.argv[2]]));\n",
  );
  const node = await execFileAsync(process.execPath, [entry, "first"], { cwd: dir });
  expect(JSON.parse(node.stdout)).toEqual([3, process.execPath, entry, "first"]);
  const result = await cli(["run", entry, "first"]);
  const executable = join(dir, ".scriptc", process.platform === "win32" ? "shape.exe" : "shape");
  expect(JSON.parse(result.stdout)).toEqual([3, "scriptc", executable, "first"]);
}, 120_000);

test("scriptc's options go before the entry, and -- ends them", async () => {
  const entry = await program("placed.ts", "console.log(process.argv.slice(2).join(' '));\n");
  const out = join(dir, process.platform === "win32" ? "placed-out.exe" : "placed-out");
  const before = await cli(["run", "-o", out, "--optimization", "dev", entry, "-o", "ignored"]);
  expect(before).toEqual({ code: 0, stdout: "-o ignored\n", stderr: "" });
  expect(existsSync(out)).toBe(true);
  expect(existsSync(join(dir, "ignored"))).toBe(false);

  const terminated = await cli(["run", "--", entry, "--strip"]);
  expect(terminated).toEqual({ code: 0, stdout: "--strip\n", stderr: "" });

  // An option scriptc does not know is an error before the entry, not a program argument.
  const unknown = await cli(["run", "--flag", entry]);
  expect(unknown).toEqual({
    code: 1,
    stdout: "",
    stderr: `scriptc: Unknown option '--flag'\n${HELP_POINTER}`,
  });
}, 120_000);

test("run ends with the program's exit code", async () => {
  const entry = await program(
    "exit.ts",
    'console.log("before");\nprocess.exit(Number(process.argv[2]));\n',
  );
  for (const bootstrap of [false, true]) {
    expect(await cli(["run", entry, "7"], bootstrap)).toEqual({
      code: 7,
      stdout: "before\n",
      stderr: "",
    });
  }
  expect((await cli(["run", entry, "0"])).code).toBe(0);
}, 120_000);

test.runIf(posix)(
  "a program killed by a signal ends run with 128 plus the signal's number",
  async () => {
    const entry = await program(
      "killed.ts",
      'process.kill(process.pid, "SIGTERM");\nsetTimeout(() => console.log("survived"), 5000);\n',
    );
    for (const bootstrap of [false, true]) {
      expect(await cli(["run", entry], bootstrap)).toEqual({
        code: 143,
        stdout: "",
        stderr: "scriptc: program killed by SIGTERM\n",
      });
    }
  },
  120_000,
);

/** Runs the program, sends `signal` to scriptc once the program has printed "ready", and
 * returns how scriptc ended. */
async function signalled(
  entry: string,
  signal: NodeJS.Signals,
): Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [...command(false), "run", entry], {
    env,
    cwd: dir,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  child.stdout.on("data", (chunk: Buffer) => {
    const ready = stdout.includes("ready\n");
    stdout += chunk.toString();
    if (!ready && stdout.includes("ready\n")) child.kill(signal);
  });
  const [code, killedBy] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve) =>
    child.on("close", (exitCode, exitSignal) => resolve([exitCode, exitSignal])),
  );
  return { code, signal: killedBy, stdout, stderr };
}

test.runIf(posix)(
  "a signal that stops run goes to the program, and run ends with the program's status",
  async () => {
    const graceful = await program(
      "graceful.ts",
      [
        'process.on("SIGTERM", () => {',
        '  console.log("terminating");',
        "  process.exit(5);",
        "});",
        'process.on("SIGINT", () => {',
        '  console.log("interrupted");',
        "  process.exit(6);",
        "});",
        "setInterval(() => {}, 1000);",
        'console.log("ready");',
        "",
      ].join("\n"),
    );
    expect(await signalled(graceful, "SIGTERM")).toEqual({
      code: 5,
      signal: null,
      stdout: "ready\nterminating\n",
      stderr: "",
    });
    // Without a terminal the interrupt reached scriptc alone, so it is handed on.
    expect(await signalled(graceful, "SIGINT")).toEqual({
      code: 6,
      signal: null,
      stdout: "ready\ninterrupted\n",
      stderr: "",
    });
    // A program that does not handle the signal dies of it. The caller asked for that, so run
    // reports it in its status only.
    const idle = await program("idle.ts", 'setInterval(() => {}, 1000);\nconsole.log("ready");\n');
    expect(await signalled(idle, "SIGTERM")).toEqual({
      code: 143,
      signal: null,
      stdout: "ready\n",
      stderr: "",
    });
  },
  120_000,
);

test.each(["run", "build", "coverage"])(
  "%s names a missing entry in one line",
  async (subcommand) => {
    const missing = join(dir, "nope.ts");
    for (const bootstrap of [false, true]) {
      expect(await cli([subcommand, "nope.ts"], bootstrap)).toEqual({
        code: 1,
        stdout: "",
        stderr: `scriptc: entry file not found: ${missing}\n`,
      });
    }
    expect(await cli([subcommand, dir])).toEqual({
      code: 1,
      stdout: "",
      stderr: `scriptc: entry is not a file: ${dir}\n`,
    });
  },
  120_000,
);

test("an unknown option prints the error, the nearest option and where the help is", async () => {
  const entry = await program("typo.ts", "console.log(1);\n");
  for (const bootstrap of [false, true]) {
    expect(await cli(["build", entry, "--optimisation", "dev"], bootstrap)).toEqual({
      code: 1,
      stdout: "",
      stderr: `scriptc: Unknown option '--optimisation'\n  did you mean '--optimization'?\n${HELP_POINTER}`,
    });
  }
  const cases: [string[], string][] = [
    [
      ["build", entry, "--no-keep-lvm"],
      "scriptc: Unknown option '--no-keep-lvm'\n  did you mean '--no-keep-llvm'?\n",
    ],
    [
      ["build", entry, "--output=x"],
      "scriptc: Unknown option '--output'\n  did you mean '--out'?\n",
    ],
    [["coverage", entry, "--explain"], "scriptc: Unknown option '--explain'\n"],
    [["build", entry, "--frobnicate"], "scriptc: Unknown option '--frobnicate'\n"],
    [["build", entry, "-x"], "scriptc: Unknown option '-x'\n"],
    [["build", entry, "--out"], "scriptc: Option '-o, --out <value>' argument missing\n"],
    [
      ["build", entry, "--optimization", "fast"],
      'unknown optimization "fast" (supported: release, dev, speed)\n',
    ],
    [["build"], "missing input file\n"],
    [["biuld", entry], "unknown command \"biuld\"\n  did you mean 'build'?\n"],
    [["typo.ts"], 'unknown command "typo.ts"\n  to compile and run a file: scriptc run typo.ts\n'],
    [["frobnicate"], 'unknown command "frobnicate"\n'],
  ];
  for (const [args, message] of cases) {
    expect(await cli(args), args.join(" ")).toEqual({
      code: 1,
      stdout: "",
      stderr: message + HELP_POINTER,
    });
  }
}, 180_000);
