import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const repoRoot = join(import.meta.dirname, "../../..");
const cliEntry = join(repoRoot, "packages/cli/src/main.ts");
const tsxLoader = join(dirname(require.resolve("tsx/package.json")), "dist/loader.mjs");

async function scriptc(args: string[], env: NodeJS.ProcessEnv) {
  return execFileAsync(process.execPath, ["--import", tsxLoader, cliEntry, ...args], {
    env,
    maxBuffer: 16 * 1024 * 1024,
  });
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

test("a build keeps its island decision and the next build replays it in one round", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-island-decision-cli-"));
  const env = { ...process.env, SCRIPTC_CACHE_DIR: join(dir, "cache"), SCRIPTC_TIMING: "1" };
  try {
    // A program whose native build fails and whose package then runs in a
    // Node island: two island rounds from scratch.
    await cp(join(repoRoot, "tests/corpus/6829-node-island-declared-types"), dir, {
      recursive: true,
    });
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

    // Each island round lowers the program once (the rounds of one build
    // share the load of the program without islands).
    const rounds = (phases: string[]) => phases.filter((p) => p === "lower").length;
    expect(rounds(scratch.phases)).toBe(2);
    expect(rounds(recording.phases)).toBe(2);
    expect(recording.phases).not.toContain("island-decision-replay");
    expect(rounds(replay.phases)).toBe(1);
    expect(replay.phases).toContain("island-decision-replay");

    // The same notes, with the package's own reason, and the same program.
    expect(scratch.output).toContain("SC8001");
    expect(recording.output).toBe(scratch.output);
    expect(replay.output).toBe(scratch.output);
    const llvm = await readFile(join(dir, "scratch.ll"), "utf8");
    expect(await readFile(join(dir, "recording.ll"), "utf8")).toBe(llvm);
    expect(await readFile(join(dir, "replay.ll"), "utf8")).toBe(llvm);

    const recorded = JSON.parse(text) as { packages: { name: string; dir: string }[] };
    expect(recorded.packages.map((p) => [p.name, p.dir])).toEqual([
      ["schemakit", "node_modules/schemakit"],
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
      format: 1,
      entry: "main.ts",
      packages: [],
      modules: [],
    });
    await build();
    await build();
    expect((await execFileAsync(binary)).stdout).toBe("a-b\n");
    expect(await readFile(decision, "utf8")).toBe(text);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 600_000);

test("the decision file is a build and run option", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-island-decision-cli-"));
  try {
    const entry = join(dir, "main.ts");
    await writeFile(entry, "console.log(1);\n");
    await expect(
      scriptc(
        ["coverage", entry, "--node-island-decision", join(dir, "islands.json")],
        process.env,
      ),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("--node-island-decision is a build/run option"),
    });
    await expect(
      scriptc(["build", entry, "--node-island-decision="], process.env),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("--node-island-decision needs a file path"),
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 120_000);
