#!/usr/bin/env node
// Records, replays and checks the Node island decision of every corpus
// program and npm-suite case (or of the entries given):
//
//   1. build --emit=ir --node-island-decision=<file>   decides from scratch, records
//   2. the same build again                            replays the record
//   3. build --node-island-decision-check              decides from scratch, compares
//
// A program passes when the replay writes the same IR and the same
// diagnostics as the recording build, lowers the program once, leaves the
// file byte for byte, and the check reports no difference. A program that
// fails before its lowering records nothing; it passes when the check says
// so too. One kind of build lowers more than once from a record, by design:
// a native build that tries a package as an island because a fence in it
// surely fires, and keeps itself when that attempt fails (SC8023). Nothing
// cheap says the attempt would fail again, so every build makes it; such a
// replay passes when it lowers no more often than its recording build.
//
// With --executables, a program that recorded an island (every program with
// --executables=all) is also built to an executable three ways: with no
// decision file, recording into a new one, and replaying that one. The three
// executables must be the same bytes. A program that runs code in Node needs
// a libnode pack for these builds (SCRIPTC_LIBNODE).
//
// This is the oracle for a change to the island rules or to the replay: any
// program whose replayed decision is not the one a build from scratch makes
// is listed, with what differs.
//
//   node scripts/island-decision-sweep.mjs [--jobs=N] [--out=<dir>] [--filter=<regex>]
//       [--executables[=all]] [entry...]
//
// Build the workspace first (pnpm -r build). Without --executables nothing
// is linked or run, so no libnode pack is needed.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const cli = join(root, "packages/cli/dist/bootstrap.js");

const options = {
  jobs: availableParallelism(),
  out: join(tmpdir(), "scriptc-island-decision-sweep"),
  filter: "",
  /** "" for none, "islands" for the programs that record an island, "all". */
  executables: "",
};
const named = [];
for (const arg of process.argv.slice(2)) {
  const executables = /^--executables(?:=(all|islands))?$/.exec(arg);
  if (executables !== null) {
    options.executables = executables[1] ?? "islands";
    continue;
  }
  const option = /^--(jobs|out|filter)=(.*)$/.exec(arg);
  if (option === null) named.push(resolve(arg));
  else if (option[1] === "jobs") options.jobs = Math.max(1, Number(option[2]) || 1);
  else if (option[1] === "out") options.out = resolve(option[2]);
  else options.filter = option[2];
}

const SOURCE = /\.(?:ts|js|mjs|cjs|mts|cts|tsx)$/;
const MAINS = ["main.ts", "main.js", "main.mjs", "main.cjs", "main.mts", "main.cts", "main.tsx"];

/** Every corpus program (a file, or a directory's main module) and every
 * npm-suite case. */
function discover() {
  const entries = [];
  const corpus = join(root, "tests/corpus");
  for (const name of readdirSync(corpus).sort()) {
    const path = join(corpus, name);
    if (statSync(path).isDirectory()) {
      const main = MAINS.find((candidate) => existsSync(join(path, candidate)));
      if (main !== undefined) entries.push(join(path, main));
    } else if (SOURCE.test(name) && !name.endsWith(".d.ts")) entries.push(path);
  }
  const cases = join(root, "tests/fixtures/npm/cases");
  if (existsSync(cases)) {
    for (const name of readdirSync(cases).sort()) {
      const main = join(cases, name, "main.ts");
      if (existsSync(main)) entries.push(main);
    }
  }
  return entries;
}

function run(args, env) {
  return new Promise((done) => {
    const child = spawn(process.execPath, ["--max-old-space-size=8000", cli, ...args], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const timer = setTimeout(() => child.kill("SIGKILL"), 15 * 60 * 1000);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      done({ code: signal === null ? code : `signal ${signal}`, stdout, stderr });
    });
  });
}

function read(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** What a build printed, without its timing lines (SCRIPTC_TIMING's phases
 * of the build and of each lowering), the line that says it wrote the file
 * and the lines of that change. */
function diagnostics(stderr) {
  const lines = stderr.split("\n");
  const kept = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^scriptc (?:timing|lowering) \{/.test(lines[i])) continue;
    if (/^scriptc: (?:recorded|updated) the Node island decision /.test(lines[i])) {
      while (i + 1 < lines.length && /^ {2}[+~-] /.test(lines[i + 1])) i++;
      continue;
    }
    kept.push(lines[i]);
  }
  return kept.join("\n");
}

/** How many times a build lowered the program: one per island round that
 * reached its lowering (SCRIPTC_TIMING's `lower` phase). */
function lowerings(stderr) {
  let count = 0;
  for (const line of stderr.split("\n"))
    if (line.startsWith("scriptc timing ") && line.includes('"phase":"lower"')) count++;
  return count;
}

/** Whether a build kept its native result after an island attempt failed. */
function keptAfterFailedAttempt(stderr) {
  return stderr.includes(" warning SC8023: ");
}

/** What is wrong with the number of times a replay lowered, or null. */
function replayRounds(recording, replay, what) {
  const count = lowerings(replay.stderr);
  if (count <= 1) return null;
  if (keptAfterFailedAttempt(replay.stderr) && count <= lowerings(recording.stderr)) return null;
  return `${what} lowers the program ${count} times`;
}

function digest(path) {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return null;
  }
}

/** Builds `entry` to an executable with no decision file, recording into a
 * new one and replaying that one, each with its own cache, and names what
 * differs between the three. */
async function compareExecutables(entry, work, env) {
  const problems = [];
  const file = join(work, "executable-islands.json");
  const builds = [];
  for (const [tag, decision] of [
    ["scratch", null],
    ["record", file],
    ["replay", file],
  ]) {
    const out = join(work, `program-${tag}`);
    const built = await run(
      [
        "build",
        entry,
        "-o",
        out,
        ...(decision === null ? [] : [`--node-island-decision=${decision}`]),
      ],
      { ...env, SCRIPTC_CACHE_DIR: join(work, `cache-${tag}`) },
    );
    builds.push({
      tag,
      code: built.code,
      bytes: digest(out),
      text: diagnostics(built.stderr),
      stderr: built.stderr,
    });
    rmSync(out, { force: true });
    rmSync(join(work, `cache-${tag}`), { recursive: true, force: true });
  }
  const [scratch, record, replay] = builds;
  for (const other of [record, replay]) {
    if (other.code !== scratch.code)
      problems.push(
        `the ${other.tag} build exits ${other.code}, the build without a file ${scratch.code}`,
      );
    if (other.bytes !== scratch.bytes)
      problems.push(
        `the ${other.tag} build's executable is not the one a build without a file writes`,
      );
    if (other.text !== scratch.text)
      problems.push(`the ${other.tag} build prints other diagnostics than a build without a file`);
  }
  const rounds = replayRounds(record, replay, "the replay to an executable");
  if (rounds !== null) problems.push(rounds);
  return { problems, built: scratch.bytes !== null };
}

async function sweepOne(entry, index) {
  const name = relative(root, entry);
  const work = join(options.out, "work", String(index));
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  const file = join(work, "islands.json");
  const ir = join(work, "program.ir");
  // The timing lines count each build's lowerings; `diagnostics` drops them.
  const env = { ...process.env, SCRIPTC_CACHE_DIR: join(work, "cache"), SCRIPTC_TIMING: "1" };
  const build = ["build", entry, "--emit=ir", "-o", ir, `--node-island-decision=${file}`];
  const problems = [];

  const recording = await run(build, env);
  const recordedFile = read(file);
  const recordedIr = read(ir);
  rmSync(ir, { force: true });
  const replay = await run(build, env);
  if (replay.code !== recording.code)
    problems.push(`the replay exits ${replay.code}, the recording build ${recording.code}`);
  if (read(ir) !== recordedIr) problems.push("the replay writes other IR than the recording build");
  if (diagnostics(replay.stderr) !== diagnostics(recording.stderr))
    problems.push("the replay prints other diagnostics than the recording build");
  if (read(file) !== recordedFile) problems.push("the replay changed the decision file");
  const rounds = { record: lowerings(recording.stderr), replay: lowerings(replay.stderr) };
  const manyRounds = replayRounds(recording, replay, "the replay");
  if (manyRounds !== null) problems.push(manyRounds);

  const check = await run(
    [...build.slice(0, 2), `--node-island-decision=${file}`, "--node-island-decision-check"],
    env,
  );
  const undecided = check.stderr.includes("fails before its Node islands are decided");
  if (recordedFile === null) {
    if (!undecided)
      problems.push(
        `nothing was recorded, and the check says: ${check.stdout.trim() || check.stderr.trim().split("\n").at(-1)}`,
      );
  } else if (check.code !== 0)
    problems.push(
      `the check differs:\n${check.stdout.trimEnd()}${undecided ? check.stderr.trimEnd() : ""}`,
    );

  let packages = 0;
  let modules = 0;
  if (recordedFile !== null) {
    const section = JSON.parse(recordedFile).decisions[0];
    packages = section.packages.length;
    modules = section.modules.length;
  }
  let executable = null;
  if (options.executables === "all" || (options.executables !== "" && packages + modules > 0)) {
    const compared = await compareExecutables(entry, work, env);
    executable = compared.built;
    problems.push(...compared.problems);
  }
  rmSync(work, { recursive: true, force: true });
  return {
    name,
    code: recording.code,
    recorded: recordedFile !== null,
    packages,
    modules,
    rounds,
    // Whether the replay made an island attempt that failed (SC8023).
    attempt: keptAfterFailedAttempt(replay.stderr),
    // null when the executables were not compared, else whether the program
    // builds to one.
    executable,
    problems,
  };
}

if (!existsSync(cli)) {
  process.stderr.write(
    `island-decision-sweep: ${relative(root, cli)} is missing; run pnpm -r build first\n`,
  );
  process.exit(2);
}
let entries = named.length > 0 ? named : discover();
if (options.filter !== "") {
  const filter = new RegExp(options.filter);
  entries = entries.filter((entry) => filter.test(relative(root, entry)));
}
mkdirSync(options.out, { recursive: true });
const results = [];
let next = 0;
await Promise.all(
  Array.from({ length: Math.min(options.jobs, entries.length) }, async () => {
    while (next < entries.length) {
      const index = next++;
      results[index] = await sweepOne(entries[index], index);
      if ((index + 1) % 250 === 0)
        process.stderr.write(`island-decision-sweep: ${index + 1} of ${entries.length}\n`);
    }
  }),
);
rmSync(join(options.out, "work"), { recursive: true, force: true });
writeFileSync(
  join(options.out, "results.jsonl"),
  results.map((result) => JSON.stringify(result)).join("\n") + "\n",
);

const failed = results.filter((result) => result.problems.length > 0);
const withIslands = results.filter((result) => result.packages + result.modules > 0);
for (const result of failed) {
  process.stdout.write(`${result.name}\n`);
  for (const problem of result.problems)
    process.stdout.write(`  ${problem.split("\n").join("\n  ")}\n`);
}
const saved = withIslands.filter((result) => result.rounds.record > result.rounds.replay);
const compared = results.filter((result) => result.executable !== null);
process.stdout.write(
  `${results.length} programs: ${results.filter((result) => result.recorded).length} recorded a decision ` +
    `(${withIslands.length} with an island), ${results.filter((result) => !result.recorded).length} stop before their lowering; ` +
    `${failed.length} differ\n` +
    `replays: ${results.filter((result) => result.rounds.replay > 1 && !result.attempt).length} lower the program more than once` +
    ` (and ${results.filter((result) => result.rounds.replay > 1 && result.attempt).length} for an island attempt that fails, SC8023); ` +
    `${saved.length} of the ${withIslands.length} with an island lower fewer times than their recording build\n` +
    (options.executables === ""
      ? ""
      : `executables: ${compared.length} programs built without a file, recording and replaying; ` +
        `${compared.filter((result) => result.executable).length} link, ` +
        `${compared.filter((result) => !result.executable).length} fail the same way three times\n`) +
    `results: ${join(options.out, "results.jsonl")}\n`,
);
process.exit(failed.length === 0 ? 0 : 1);
