import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { CLI_FAST_PATHS, CLI_OPTIONS, type CliOptionName } from "../../compiler/src/cli/usage.js";

const repoRoot = join(import.meta.dirname, "../../..");
const bootstrap = join(repoRoot, "packages/cli/dist/bootstrap.js");
const fullCli = join(repoRoot, "packages/cli/dist/main.js");

interface Outcome {
  status: number;
  stdout: string;
  stderr: string;
}

/** A scratch directory with its own build cache. */
interface Scratch {
  dir: string;
  env: NodeJS.ProcessEnv;
}

/** Runs a CLI entry inside the scratch directory, where a relative path an option names stays
 * out of the repository. `preload` is a module Node imports first. */
function invoke(
  script: string,
  args: string[],
  { dir, env }: Scratch,
  preload?: string,
): Promise<Outcome> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [...(preload === undefined ? [] : ["--import", preload]), script, ...args],
      { env, cwd: dir, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error === null) resolve({ status: 0, stdout, stderr });
        else if (typeof error.code === "number") resolve({ status: error.code, stdout, stderr });
        else reject(error);
      },
    );
  });
}

async function scratch(name: string): Promise<Scratch> {
  const dir = await mkdtemp(join(tmpdir(), `scriptc-bootstrap-options-${name}-`));
  await mkdir(join(dir, "cache"), { mode: 0o700 });
  const env = { ...process.env, SCRIPTC_CACHE_DIR: join(dir, "cache") };
  delete env.SCRIPTC_NO_CACHE;
  delete env.SCRIPTC_TIMING;
  return { dir, env };
}

/** A value for each string option that has a meaning the launcher or the full CLI looks at;
 * any other string option takes `x`. */
function optionValues(dir: string): Partial<Record<CliOptionName, string>> {
  return {
    out: join(dir, "out", "program"),
    emit: "exe",
    print: "diagnostics",
    "fail-on": "blockers",
    coverage: "reached",
    backend: "llvm",
    optimization: "dev",
    "windows-subsystem": "gui",
    libnode: join(dir, "libnode"),
    exceptions: "rare",
    "target-cpu": "baseline",
    ffi: join(dir, "missing.ffi.json"),
    "npm-static": "auto",
    "external-types": `host=${join(dir, "host.d.ts")}`,
    tier: "static-only",
    "explain-dynamic": "main",
    "node-islands": "explicit",
  };
}

/** The arguments that set `option`: a boolean is switched away from its default. */
function spelling(option: CliOptionName, values: Partial<Record<CliOptionName, string>>): string[] {
  const config: { type: string; default?: boolean } = CLI_OPTIONS[option];
  if (config.type === "boolean")
    return [config.default === true ? `--no-${option}` : `--${option}`];
  return [`--${option}=${values[option] ?? "x"}`];
}

test("each string option a fast path answers for has a value here", () => {
  const values = optionValues("/tmp");
  for (const [name, fastPath] of Object.entries(CLI_FAST_PATHS)) {
    for (const option of fastPath.options) {
      const config: { type: string } = CLI_OPTIONS[option];
      if (config.type === "string") expect(values[option], `${name}: --${option}`).toBeDefined();
    }
  }
});

/** A module that makes loading the compiler fail, so a launcher that hands a command line to
 * the full CLI stops with this message instead of doing the work. */
const REJECT_FULL_COMPILER = [
  "import { registerHooks } from 'node:module';",
  "registerHooks({ load(url, context, nextLoad) {",
  "  if (url.includes('/packages/compiler/dist/index.js')) throw new Error('compiler graph loaded');",
  "  return nextLoad(url, context);",
  "}});",
  "",
].join("\n");

/** The launcher answers a cached program without loading the compiler, and only for the options
 * its fast path names (and `--help` and `--version`). With any other option it has to hand the
 * command line to the full CLI, whatever is cached. With an option it does answer for, its
 * answer has to be the full CLI's: the same status, stdout and stderr, on the launcher's first
 * run and again once the command with that option may have a cached answer of its own. */
test.concurrent.each(["build", "run", "coverage"])(
  "the launcher answers a cached %s only for the options its fast path names",
  async (command) => {
    const at = await scratch(command);
    const { dir } = at;
    const entry = join(dir, "main.ts");
    const preload = join(dir, "reject-full-compiler.mjs");
    const fastPath = Object.values(CLI_FAST_PATHS).find((path) => path.commands.includes(command));
    const answered: readonly string[] = [...(fastPath?.options ?? []), "help", "version"];
    try {
      await writeFile(entry, 'console.log("one");\n');
      await writeFile(join(dir, "host.d.ts"), "export declare const value: number;\n");
      await writeFile(preload, REJECT_FULL_COMPILER);
      const plain = await invoke(bootstrap, [command, entry], at);
      expect(plain.status, plain.stderr).toBe(0);
      expect(await invoke(bootstrap, [command, entry], at)).toEqual(plain);
      const values = optionValues(dir);
      for (const option of Object.keys(CLI_OPTIONS) as CliOptionName[]) {
        // Options go before the entry: what follows it may be the program's.
        const args = [command, ...spelling(option, values), entry];
        if (!answered.includes(option)) {
          const handed = await invoke(bootstrap, args, at, preload);
          expect(handed.stderr, `${args.join(" ")}: left to the full CLI`).toContain(
            "compiler graph loaded",
          );
          continue;
        }
        const first = await invoke(bootstrap, args, at);
        const full = await invoke(fullCli, args, at);
        const second = await invoke(bootstrap, args, at);
        expect(first, `${args.join(" ")}: first launcher run`).toEqual(full);
        expect(second, `${args.join(" ")}: second launcher run`).toEqual(full);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
  600_000,
);

/** `--tier=static-only` refuses what the default tier compiles with a dynamic slot
 * (tests/diagnostics/union-spread-merge.ts), so the verdict of the default analysis must not
 * answer for it: with `--fail-on=blockers` the cached program passed where the full CLI fails.
 * For `build` this holds the launcher to the full CLI's answer and no further: the full
 * compiler's executable cache does not key the tier, so it answers a static-only build from
 * the default one's entry. */
test("a cached program does not answer for --tier=static-only", async () => {
  const at = await scratch("tier");
  const { dir } = at;
  const entry = join(dir, "main.ts");
  try {
    await cp(join(repoRoot, "tests/diagnostics/union-spread-merge.ts"), entry);
    for (const command of ["build", "coverage"]) {
      const plain = await invoke(bootstrap, [command, entry], at);
      expect(plain.status, plain.stderr).toBe(0);
      expect((await invoke(bootstrap, [command, entry], at)).status).toBe(0);
    }
    const coverage = ["coverage", "--tier=static-only", "--fail-on=blockers", entry];
    const strictCoverage = await invoke(bootstrap, coverage, at);
    expect(strictCoverage.status).toBe(1);
    expect(strictCoverage.stdout).toContain("SC2003");
    expect(strictCoverage).toEqual(await invoke(fullCli, coverage, at));
    const build = ["build", "--tier=static-only", entry];
    expect(await invoke(bootstrap, build, at)).toEqual(await invoke(fullCli, build, at));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 300_000);
