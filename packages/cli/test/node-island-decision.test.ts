import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const repoRoot = join(import.meta.dirname, "../../..");
const cliEntry = join(repoRoot, "packages/cli/src/main.ts");
const tsxLoader = join(dirname(require.resolve("tsx/package.json")), "dist/loader.mjs");

async function scriptc(args: string[], env: NodeJS.ProcessEnv, cwd?: string) {
  return execFileAsync(process.execPath, ["--import", tsxLoader, cliEntry, ...args], {
    env,
    maxBuffer: 16 * 1024 * 1024,
    ...(cwd === undefined ? {} : { cwd }),
  });
}

/** The exit status and output of a command that may fail. */
async function attempt(
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd?: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await scriptc(args, env, cwd);
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failed.code ?? -1, stdout: failed.stdout ?? "", stderr: failed.stderr ?? "" };
  }
}

/** The phases a build with SCRIPTC_TIMING=1 reports, and its other output. */
function split(stderr: string): { phases: string[]; output: string } {
  const phases: string[] = [];
  const output: string[] = [];
  for (const line of stderr.split("\n")) {
    const timing = /^scriptc timing (\{.*\})$/.exec(line);
    if (timing !== null) phases.push((JSON.parse(timing[1]!) as { phase: string }).phase);
    else if (!line.startsWith("scriptc ")) output.push(line);
  }
  return { phases, output: output.join("\n") };
}

/** Each island round lowers the program once (the rounds of one build share
 * the load of the program without islands). */
function rounds(phases: string[]): number {
  return phases.filter((p) => p === "lower").length;
}

interface Section {
  entry: string;
  outcome?: string;
  packages: { name: string; dir: string; rule?: string }[];
}

async function sections(file: string): Promise<Section[]> {
  return (JSON.parse(await readFile(file, "utf8")) as { decisions: Section[] }).decisions;
}

/** A copy of a program whose native build fails and whose package then runs
 * in a Node island (the fence report): two island rounds from scratch. */
async function islandProject(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-island-decision-cli-"));
  await cp(join(repoRoot, "tests/corpus/6829-node-island-declared-types"), dir, {
    recursive: true,
  });
  return dir;
}

const RECORDED =
  "  + schemakit@1.0.0 (fence-report): R2.1 constructor functions: a write of 'Schema.prototype.describe'\n";

test("a build keeps its island decision and the next build replays it in one round", async () => {
  const dir = await islandProject();
  const env = { ...process.env, SCRIPTC_CACHE_DIR: join(dir, "cache"), SCRIPTC_TIMING: "1" };
  try {
    const entry = join(dir, "main.ts");
    const decision = join(dir, "islands.json");
    const build = (out: string, withDecision: boolean) =>
      scriptc(
        [
          "build",
          entry,
          "--emit=llvm",
          "-o",
          join(dir, out),
          ...(withDecision ? ["--node-island-decision", decision] : []),
        ],
        env,
      );
    const scratch = split((await build("scratch.ll", false)).stderr);
    const recording = split((await build("recording.ll", true)).stderr);
    const text = await readFile(decision, "utf8");
    const replay = split((await build("replay.ll", true)).stderr);

    expect(rounds(scratch.phases)).toBe(2);
    expect(rounds(recording.phases)).toBe(2);
    expect(recording.phases).not.toContain("island-decision-replay");
    expect(rounds(replay.phases)).toBe(1);
    expect(replay.phases).toContain("island-decision-replay");

    // The same notes, with the package's own reason, and the same program.
    // The build that wrote the file says so, and what it wrote; the build
    // that found its decision standing says nothing more than a build
    // without the file.
    expect(scratch.output).toContain("SC8001");
    expect(recording.output).toBe(
      `scriptc: recorded the Node island decision in ${decision} (1 package)\n${RECORDED}${scratch.output}`,
    );
    expect(replay.output).toBe(scratch.output);
    const llvm = await readFile(join(dir, "scratch.ll"), "utf8");
    expect(await readFile(join(dir, "recording.ll"), "utf8")).toBe(llvm);
    expect(await readFile(join(dir, "replay.ll"), "utf8")).toBe(llvm);

    const recorded = (await sections(decision))[0]!;
    expect(recorded.packages.map((p) => [p.name, p.dir, p.rule])).toEqual([
      ["schemakit", "node_modules/schemakit", "fence-report"],
    ]);
    expect(await readFile(decision, "utf8")).toBe(text);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 600_000);

test("an executable built with a decision file is cached by the file's bytes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-island-decision-cli-"));
  const env = { ...process.env, SCRIPTC_CACHE_DIR: join(dir, "cache") };
  try {
    const entry = join(dir, "main.ts");
    await writeFile(entry, 'console.log(["a", "b"].join("-"));\n');
    const decision = join(dir, "islands.json");
    const binary = join(dir, "program");
    const build = () =>
      scriptc(["build", entry, "-o", binary, "--node-island-decision", decision], env);
    // The first build writes the file, so the second is keyed by other bytes
    // and builds again; from then on the key is stable.
    await build();
    expect((await execFileAsync(binary)).stdout).toBe("a-b\n");
    const text = await readFile(decision, "utf8");
    expect(JSON.parse(text)).toMatchObject({
      format: 2,
      decisions: [{ entry: "main.ts", packages: [], modules: [] }],
    });
    await build();
    await build();
    expect((await execFileAsync(binary)).stdout).toBe("a-b\n");
    expect(await readFile(decision, "utf8")).toBe(text);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 600_000);

test("the project's key names the file: builds record and replay it without a flag", async () => {
  const dir = await islandProject();
  const env = { ...process.env, SCRIPTC_CACHE_DIR: join(dir, "cache"), SCRIPTC_TIMING: "1" };
  try {
    await writeFile(
      join(dir, "package.json"),
      `${JSON.stringify({ name: "app", scriptc: { nodeIslands: { decision: true } } }, null, 2)}\n`,
    );
    const decision = join(dir, "scriptc-islands.json");
    const build = (out: string, ...more: string[]) =>
      scriptc(["build", "main.ts", "--emit=llvm", "-o", out, ...more], env, dir);
    const first = split((await build("first.ll")).stderr);
    expect(rounds(first.phases)).toBe(2);
    // Run from the project: the file is named as the user would type it.
    expect(first.output).toContain(
      `scriptc: recorded the Node island decision in scriptc-islands.json (1 package)\n${RECORDED}`,
    );
    const text = await readFile(decision, "utf8");
    expect((await sections(decision)).map((s) => [s.entry, s.outcome])).toEqual([
      ["main.ts", "compiles"],
    ]);

    const second = split((await build("second.ll")).stderr);
    expect(rounds(second.phases)).toBe(1);
    expect(second.phases).toContain("island-decision-replay");
    expect(second.output).not.toContain("Node island decision");
    expect(await readFile(join(dir, "second.ll"), "utf8")).toBe(
      await readFile(join(dir, "first.ll"), "utf8"),
    );

    // One build without the file: decided from scratch, nothing written.
    const ignoring = split((await build("third.ll", "--ignore-node-island-decision")).stderr);
    expect(rounds(ignoring.phases)).toBe(2);
    expect(ignoring.phases).not.toContain("island-decision-replay");
    expect(await readFile(decision, "utf8")).toBe(text);
    // Deleted, it is recorded again.
    await rm(decision);
    await build("fourth.ll", "--ignore-node-island-decision");
    expect(existsSync(decision)).toBe(false);
    await build("fifth.ll");
    expect(await readFile(decision, "utf8")).toBe(text);

    // A second entry of the project gets its own section.
    await writeFile(join(dir, "tool.ts"), "console.log(1 + 1);\n");
    await scriptc(["build", "tool.ts", "--emit=llvm", "-o", "tool.ll"], env, dir);
    expect((await sections(decision)).map((s) => [s.entry, s.packages.length])).toEqual([
      ["main.ts", 1],
      ["tool.ts", 0],
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 600_000);

test("coverage replays the file and never writes it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-island-decision-cli-"));
  const env = { ...process.env, SCRIPTC_CACHE_DIR: join(dir, "cache") };
  try {
    // A package whose own class refuses to lower: an analysis finds that by
    // lowering it natively once, a build's record says it up front.
    await cp(join(repoRoot, "tests/corpus/8809-node-island-asserted-receivers"), dir, {
      recursive: true,
    });
    const entry = join(dir, "main.ts");
    const decision = join(dir, "islands.json");
    const coverage = (...more: string[]) =>
      attempt(["coverage", entry, "--fail-on=blockers", ...more], env);
    /** The statement counts of a report. */
    const counts = (stdout: string) =>
      stdout.split("\n").filter((line) => /statements analyzed|compile statically/.test(line));
    const from = await coverage();
    expect(from.stdout).toContain("sdk-pkg@1.0.0");
    expect(counts(from.stdout)).toHaveLength(2);
    // An analysis records nothing, so a file it is given stays absent.
    const absent = await coverage("--node-island-decision", decision);
    expect(absent.stdout).toBe(from.stdout);
    expect(existsSync(decision)).toBe(false);

    await scriptc(
      ["build", entry, "--emit=llvm", "-o", join(dir, "a.ll"), "--node-island-decision", decision],
      env,
    );
    const text = await readFile(decision, "utf8");
    // With the build's record the analysis reports the same program, and
    // still names the island, with the reason the build recorded.
    const replayed = await coverage("--node-island-decision", decision);
    expect(replayed.code).toBe(from.code);
    expect(counts(replayed.stdout)).toEqual(counts(from.stdout));
    expect(replayed.stdout).toContain("sdk-pkg@1.0.0");
    expect(await readFile(decision, "utf8")).toBe(text);
    // The verdict follows the file's bytes: without the record again, the
    // analysis answers as it did before.
    await rm(decision);
    const again = await coverage("--node-island-decision", decision);
    expect(again.stdout).toBe(from.stdout);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 600_000);

test("the check decides from scratch, compares with the file and writes nothing", async () => {
  const dir = await islandProject();
  const env = { ...process.env, SCRIPTC_CACHE_DIR: join(dir, "cache"), SCRIPTC_TIMING: "1" };
  try {
    const decision = join(dir, "islands.json");
    const check = () =>
      attempt(
        [
          "build",
          "main.ts",
          "--node-island-decision",
          "islands.json",
          "--node-island-decision-check",
        ],
        env,
        dir,
      );
    // Nothing recorded yet.
    const missing = await check();
    expect(missing.code).toBe(1);
    expect(missing.stdout).toBe(
      "the Node island decision of main.ts differs from islands.json\n" +
        "  the file does not exist\n" +
        'a build from scratch decides 1 package, 0 modules; "+" is an island the file lacks, "-" one a build from scratch does not run in Node\n' +
        "to record the decision again, delete this entry from islands.json (or the file) and build\n",
    );
    expect(existsSync(decision)).toBe(false);
    expect(existsSync(join(dir, ".scriptc"))).toBe(false);

    await scriptc(
      ["build", "main.ts", "--emit=llvm", "-o", "a.ll", "--node-island-decision", "islands.json"],
      env,
      dir,
    );
    const text = await readFile(decision, "utf8");
    const same = await check();
    expect(same.code).toBe(0);
    expect(same.stdout).toBe(
      "the Node island decision of main.ts matches islands.json (1 package, 0 modules)\n",
    );
    // From scratch: both rounds, and no replay.
    const phases = split(same.stderr).phases;
    expect(rounds(phases)).toBe(2);
    expect(phases).not.toContain("island-decision-replay");

    // A record that lacks the island, and one with an island a build from
    // scratch does not have.
    const parsed = JSON.parse(text) as { format: number; decisions: Section[] };
    const { outcome: _outcome, ...withoutOutcome } = parsed.decisions[0]!;
    const island = parsed.decisions[0]!.packages[0]!;
    await writeFile(
      decision,
      JSON.stringify({ format: 2, decisions: [{ ...withoutOutcome, packages: [] }] }),
    );
    const lacking = await check();
    expect(lacking.code).toBe(1);
    expect(lacking.stdout).toContain("  ~ outcome: none -> compiles\n");
    expect(lacking.stdout).toContain(RECORDED);
    await writeFile(
      decision,
      JSON.stringify({
        format: 2,
        decisions: [
          {
            ...parsed.decisions[0]!,
            packages: [island, { ...island, name: "left-over", dir: "node_modules/left-over" }],
          },
        ],
      }),
    );
    const tampered = await readFile(decision, "utf8");
    const extra = await check();
    expect(extra.code).toBe(1);
    expect(extra.stdout).toContain("  - left-over@1.0.0\n");
    expect(extra.stdout).not.toContain("  + ");
    // The check never writes.
    expect(await readFile(decision, "utf8")).toBe(tampered);

    // A program that fails before its lowering decides nothing.
    await writeFile(join(dir, "main.ts"), 'const wrong: number = "text";\nconsole.log(wrong);\n');
    const undecided = await check();
    expect(undecided.code).toBe(1);
    expect(undecided.stderr).toContain(
      "scriptc: main.ts fails before its Node islands are decided, so there is nothing to compare with islands.json",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 600_000);

test("the decision options are refused where they mean nothing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-island-decision-cli-"));
  try {
    const entry = join(dir, "main.ts");
    await writeFile(entry, "console.log(1);\n");
    const refused = async (args: string[], message: string) => {
      const result = await attempt(args, process.env);
      expect(result.code, args.join(" ")).not.toBe(0);
      expect(result.stderr, args.join(" ")).toContain(message);
    };
    await refused(
      ["build", entry, "--node-island-decision="],
      "--node-island-decision needs a file path",
    );
    await refused(
      ["run", entry, "--node-island-decision-check"],
      "--node-island-decision-check is a build option",
    );
    await refused(
      ["coverage", entry, "--node-island-decision-check"],
      "--node-island-decision-check is a build option",
    );
    await refused(
      ["build", entry, "--ignore-node-island-decision", "--node-island-decision", "x.json"],
      "--ignore-node-island-decision and --node-island-decision contradict each other",
    );
    await refused(
      ["build", entry, "--ignore-node-island-decision", "--node-island-decision-check"],
      "--node-island-decision-check needs the decision file",
    );
    // No file named by a flag or by the project: nothing to check against.
    await refused(
      ["build", entry, "--node-island-decision-check"],
      "--node-island-decision-check needs a decision file",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 120_000);
