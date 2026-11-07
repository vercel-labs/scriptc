import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { afterAll, beforeEach, expect, test, vi } from "vitest";
import { runCli } from "./command.js";
import type { CliHost } from "./host.js";
import {
  CLI_COMMANDS,
  CLI_FAST_PATHS,
  CLI_OPTIONS,
  cliOptionIsSet,
  firstCliOptionOutside,
  firstUnacceptedOption,
  type CliOptionName,
} from "./usage.js";

const scratch = mkdtempSync(join(tmpdir(), "scriptc-command-test-"));
const entry = join(scratch, "main.ts");
const declaration = join(scratch, "host.d.ts");
writeFileSync(entry, 'console.log("one");\n');
writeFileSync(declaration, "export declare const value: number;\n");
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const OPTION_NAMES = Object.keys(CLI_OPTIONS) as CliOptionName[];

let stderr = "";
beforeEach(() => {
  stderr = "";
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderr += String(chunk);
    return true;
  });
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  return () => vi.restoreAllMocks();
});

/** What a command line came to: the compiler operation it reached, or the first line of the
 * usage error that refused it. */
type Outcome = { reached: string } | { refused: string };

async function dispatch(args: string[]): Promise<Outcome> {
  let reached: string | null = null;
  const reach = (operation: string) => (): never => {
    reached ??= operation;
    throw new Error(operation);
  };
  // Windows is the one target that takes every executable option (--windows-subsystem).
  const host: CliHost = {
    version: () => "0.0.0-test",
    sourceTargetPlatform: () => "win32",
    analyze: reach("analyze"),
    compile: reach("compile"),
    compileLibrary: reach("compileLibrary"),
    resolveProvenanceSources: reach("resolveProvenanceSources"),
    warmNativeCaches: reach("warmNativeCaches"),
    mergeProfiles: reach("mergeProfiles"),
    typePatches: reach("typePatches"),
    run: reach("run"),
    reinvoke: reach("reinvoke"),
  };
  stderr = "";
  const code = await runCli(args, host).catch(() => null);
  if (reached !== null) return { reached };
  expect(code, args.join(" ")).toBe(1);
  return { refused: stderr.split("\n")[0]! };
}

/** A value for each option whose value the command line checks; any other string option takes
 * `x` and a boolean one is switched away from its default. */
const VALUES: Partial<Record<CliOptionName, string>> = {
  emit: "exe",
  print: "diagnostics",
  "fail-on": "blockers",
  backend: "llvm",
  optimization: "dev",
  "windows-subsystem": "gui",
  exceptions: "rare",
  "target-cpu": "x86-64-v3",
  "external-types": `host=${declaration}`,
  tier: "static-only",
  "node-islands": "explicit",
};

function spelling(option: CliOptionName): string {
  const config: { type: string; default?: boolean } = CLI_OPTIONS[option];
  if (config.type === "boolean") return config.default === true ? `--no-${option}` : `--${option}`;
  return `--${option}=${VALUES[option] ?? "x"}`;
}

/** Each command's leading words and its positionals; an option goes between them. */
const COMMAND_LINES: Record<string, readonly [string[], string[]]> = {
  build: [["build"], [entry]],
  run: [["run"], [entry]],
  coverage: [["coverage"], [entry]],
  "build-lib": [["build", "--lib", `--profile=${join(scratch, "profile.json")}`], []],
  "types-patch": [
    ["types", "patch"],
    ["left-pad", "Options.width", "number"],
  ],
  "types-list": [["types", "list"], []],
  "cache-warm": [["cache", "warm"], []],
  "merge-profiles": [
    ["merge-profiles", `--out=${join(scratch, "merged.profdata")}`],
    ["a.profraw"],
  ],
};

const NOT_EXECUTABLE = "is a build/run option";
const TYPES_PATCH_ONLY = "--range and --dry-run are scriptc types patch options";
const MERGE_ONLY = "--sparse is a merge-profiles option";
const LIB_ONLY = "--lib is a build mode (scriptc build --lib --profile <p.json>)";
const TYPES_USAGE =
  'scriptc types takes "patch <package> <selector> <type>" (with --range or --dry-run) or "list"';
const BUILD_AND_RUN: Partial<Record<CliOptionName, string>> = {
  "fail-on": "--fail-on is a coverage option (a build already fails on blockers)",
  sparse: MERGE_ONLY,
  range: TYPES_PATCH_ONLY,
  "dry-run": TYPES_PATCH_ONLY,
  "external-types": "--external-types is a coverage-only option",
  "explain-dynamic": "--explain-dynamic is a coverage option",
  wasm: "--wasm is a coverage-only option",
  "explain-island": "--explain-island is a coverage option",
  "strict-user-js": "--strict-user-js is a coverage option",
};

/** How each command refuses an option its row does not name: `every` is the one message of a
 * command that has one, `by` the message of an option that has its own. The first line only:
 * the help follows it. An option added later is in neither, and is refused all the same: by a
 * check of its own, or by name (`--<option> is not a <command> option`). */
const REFUSALS: Record<string, { every?: string; by?: Partial<Record<CliOptionName, string>> }> = {
  build: { by: { ...BUILD_AND_RUN, lib: "scriptc build --lib needs --profile <profile.json>" } },
  run: {
    by: {
      ...BUILD_AND_RUN,
      print: "--print=diagnostics is a build/coverage option",
      lib: LIB_ONLY,
    },
  },
  coverage: {
    by: {
      emit: `--emit ${NOT_EXECUTABLE}`,
      strip: `--strip ${NOT_EXECUTABLE}`,
      static: `--static ${NOT_EXECUTABLE}`,
      "windows-subsystem": "--windows-subsystem is only supported for executable builds",
      "detached-exit": `--detached-exit ${NOT_EXECUTABLE}`,
      "stdout-buffering": `--stdout-buffering ${NOT_EXECUTABLE}`,
      "large-pages": `--large-pages ${NOT_EXECUTABLE}`,
      exceptions: `--exceptions ${NOT_EXECUTABLE}`,
      "target-cpu": `--target-cpu ${NOT_EXECUTABLE}`,
      "cpu-dispatch": `--cpu-dispatch ${NOT_EXECUTABLE}`,
      "profile-generate": `--profile-generate ${NOT_EXECUTABLE}`,
      "profile-use": `--profile-use ${NOT_EXECUTABLE}`,
      sparse: MERGE_ONLY,
      range: TYPES_PATCH_ONLY,
      "dry-run": TYPES_PATCH_ONLY,
      lib: LIB_ONLY,
    },
  },
  "build-lib": {
    every:
      "scriptc build --lib takes no --backend/--emit/--print/--optimization/--strip/--static/--windows-subsystem/--detached-exit/--large-pages/--stdout-buffering/--exceptions/--target-cpu/--cpu-dispatch/--profile-generate/--profile-use/--npm-static/--ffi/--external-types/--tier/--explain-dynamic: the profile pins the emission and optimization, npm imports are judged automatically, outbound FFI belongs to executable builds, external type mappings belong to coverage, and library artifacts are static-tier only",
    by: { sparse: MERGE_ONLY, range: TYPES_PATCH_ONLY, "dry-run": TYPES_PATCH_ONLY },
  },
  "types-patch": {},
  "types-list": { by: { range: TYPES_USAGE, "dry-run": TYPES_USAGE } },
  "cache-warm": {
    every: "scriptc cache warm takes only native optimization/sanitizer options and profile names",
  },
  "merge-profiles": {
    every:
      "scriptc merge-profiles takes -o <out.profdata>, optionally --sparse, and one or more profiles",
  },
};

/** Commands that do not check their options: every option but the ones `REFUSALS` names passes.
 * A decision not yet taken (see `toleratedOptions`), kept as it was. */
const UNCHECKED = new Map([
  ["types-patch", "scriptc types patch reads --range and --dry-run and looks at no other option"],
  ["types-list", "scriptc types list refuses --range and --dry-run and looks at no other option"],
]);

test("every command has a command line here", () => {
  expect(Object.keys(COMMAND_LINES).sort()).toEqual(CLI_COMMANDS.map((cmd) => cmd.name).sort());
  expect(Object.keys(REFUSALS).sort()).toEqual(CLI_COMMANDS.map((cmd) => cmd.name).sort());
});

test("a command takes the options its row names and refuses every other one", async () => {
  let taken = 0;
  let refused = 0;
  let unchecked = 0;
  for (const cmd of CLI_COMMANDS) {
    const [words, positionals] = COMMAND_LINES[cmd.name]!;
    expect(await dispatch([...words, ...positionals]), cmd.name).toHaveProperty("reached");
    for (const option of OPTION_NAMES) {
      // These answer before any command runs.
      if (option === "help" || option === "version") continue;
      const outcome = await dispatch([...words, spelling(option), ...positionals]);
      const refusal = REFUSALS[cmd.name]!;
      const named =
        cmd.options.includes(option) ||
        cmd.toleratedOptions.includes(option) ||
        cmd.argv.includes(`--${option}`);
      const where = `scriptc ${words.join(" ")} ${spelling(option)}`;
      if (named) {
        // The row and the refusals must not both claim an option.
        expect(refusal.by?.[option], where).toBeUndefined();
        expect(outcome, where).toHaveProperty("reached");
        taken++;
      } else if (UNCHECKED.has(cmd.name) && refusal.by?.[option] === undefined) {
        expect(outcome, where).toHaveProperty("reached");
        unchecked++;
      } else {
        const pinned = refusal.by?.[option] ?? refusal.every;
        if (pinned === undefined) expect(outcome, where).toHaveProperty("refused");
        else expect(outcome, where).toEqual({ refused: pinned });
        refused++;
      }
    }
  }
  // Every command line above was one of the three; none was skipped.
  expect(taken + refused + unchecked).toBe(CLI_COMMANDS.length * (OPTION_NAMES.length - 2));
  expect(Math.min(taken, refused, unchecked)).toBeGreaterThan(0);
});

test("a command's row decides which options it refuses", () => {
  // The rows decide: `run` takes both options, `coverage` tolerates `--out` only, and
  // `types list` names neither.
  const { values } = parseArgs({
    args: ["--strip", "--out=x"],
    options: CLI_OPTIONS,
    allowPositionals: true,
    allowNegative: true,
  });
  expect(firstUnacceptedOption("run", values)).toBeUndefined();
  expect(firstUnacceptedOption("coverage", values)).toBe("strip");
  expect(firstUnacceptedOption("types-list", values)).toBe("out");
  expect(() => firstUnacceptedOption("frobnicate", values)).toThrow("no command frobnicate");
});

function parsed(...args: string[]) {
  return parseArgs({ args, options: CLI_OPTIONS, allowPositionals: true, allowNegative: true })
    .values;
}

test("an option is set when the command line moves it off its default", () => {
  const set = (...args: string[]): CliOptionName[] => {
    const values = parsed(...args);
    return OPTION_NAMES.filter((option) => cliOptionIsSet(values, option));
  };
  expect(set()).toEqual([]);
  // The spellings of a default set nothing, as the hand-written checks had it.
  expect(set("--no-strip", "--keep-llvm", "--dynamic-tier-warning", "--no-lib")).toEqual([]);
  expect(set("--strip", "--no-keep-llvm", "--no-dynamic-tier-warning")).toEqual([
    "strip",
    "keep-llvm",
    "dynamic-tier-warning",
  ]);
  // A boolean without a default is set either way.
  expect(set("--cpu-dispatch")).toEqual(["cpu-dispatch"]);
  expect(set("--no-cpu-dispatch")).toEqual(["cpu-dispatch"]);
  expect(set("--no-shape-overlay")).toEqual(["shape-overlay"]);
  // The last spelling of a boolean wins.
  expect(set("--strip", "--no-strip")).toEqual([]);
  // A string is set by any value, the empty one included.
  expect(set("-o", "x", "--explain-dynamic=", "--node=")).toEqual([
    "out",
    "explain-dynamic",
    "node",
  ]);
  expect(set("--npm-static=a", "--npm-static=b", "--wasm=")).toEqual(["npm-static", "wasm"]);
});

test("the first option outside a list is the first in the table's order", () => {
  const values = parsed("--wasm=x", "--strip", "--tier=auto", "-o", "x");
  expect(firstCliOptionOutside(values, OPTION_NAMES)).toBeUndefined();
  expect(firstCliOptionOutside(values, [])).toBe("out");
  expect(firstCliOptionOutside(values, ["out", "strip"])).toBe("tier");
  expect(firstCliOptionOutside(values, ["out", "strip", "tier"])).toBe("wasm");
  expect(firstCliOptionOutside(parsed(), [])).toBeUndefined();
});

test("a fast path answers only for options that every command it serves takes", () => {
  for (const [name, fastPath] of Object.entries(CLI_FAST_PATHS)) {
    expect(fastPath.commands.length, name).toBeGreaterThan(0);
    for (const commandName of fastPath.commands) {
      const cmd = CLI_COMMANDS.find((candidate) => candidate.name === commandName);
      expect(cmd, `${name}: ${commandName}`).toBeDefined();
      for (const option of fastPath.options)
        expect(cmd!.options, `${name} answers --${option} for ${commandName}`).toContain(option);
    }
  }
});

/** The census of the old form: a run of lines that each test one option and end in `||`. The
 * three chains in command.ts and the two in the launcher were 14 to 29 such lines each, and each
 * had to be edited for every new option. */
function optionChains(source: string): string[] {
  const term = /^\s*\(?!?\(?values(?:\.[a-zA-Z]+|\["[a-z-]+"\])[^;{]*\|\|\s*$/;
  const chains: string[] = [];
  let run: string[] = [];
  for (const line of [...source.split("\n"), ""]) {
    if (term.test(line)) {
      run.push(line.trim());
    } else if (!/^\s*\/\//.test(line)) {
      if (run.length >= 3) chains.push(run.join(" "));
      run = [];
    }
  }
  return chains;
}

test("no command or fast path lists options by hand", () => {
  expect(
    optionChains(
      "if (\n  values.lib ||\n  // why\n  values.out !== undefined ||\n  !values.x ||\n",
    ),
  ).toHaveLength(1);
  const sources = {
    "packages/compiler/src/cli/command.ts": join(import.meta.dirname, "command.ts"),
    "packages/cli/src/bootstrap.ts": join(import.meta.dirname, "../../../cli/src/bootstrap.ts"),
  };
  // A chain a file may keep, as `<file>: <chain>`, with the reason. None today.
  const allowed: Record<string, string> = {};
  const found: Record<string, string> = {};
  for (const [name, path] of Object.entries(sources)) {
    const source = readFileSync(path, "utf8");
    for (const chain of optionChains(source)) {
      const site = `${name}: ${chain}`;
      found[site] = allowed[site] ?? "no reason given";
    }
    expect(source, `${name}: one list of Node island options (cli/usage.ts)`).not.toContain(
      "hasNodeIslandFlags",
    );
  }
  expect(
    found,
    "name the options a command takes in CLI_COMMANDS, or the ones a fast path answers for in " +
      "CLI_FAST_PATHS (cli/usage.ts), and ask firstUnacceptedOption or firstCliOptionOutside",
  ).toEqual(allowed);
});
