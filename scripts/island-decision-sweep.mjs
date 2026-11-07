#!/usr/bin/env node
// Records, replays and checks the Node island decision of every corpus
// program and npm-suite case (or of the entries given):
//
//   1. build --emit=ir --node-island-decision=<file>   decides from scratch, records
//   2. the same build again                            replays the record
//   3. build --node-island-decision-check              decides from scratch, compares
//
// A program passes when the replay writes the same IR and the same
// diagnostics as the recording build, leaves the file byte for byte, and the
// check reports no difference. A program that fails before its lowering
// records nothing; it passes when the check says so too.
//
// This is the oracle for a change to the island rules or to the replay: any
// program whose replayed decision is not the one a build from scratch makes
// is listed, with what differs.
//
//   node scripts/island-decision-sweep.mjs [--jobs=N] [--out=<dir>] [--filter=<regex>] [entry...]
//
// Build the workspace first (pnpm -r build). Programs that run code in Node
// need no libnode pack here: nothing is linked or run.
import { spawn } from "node:child_process";
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
};
const named = [];
for (const arg of process.argv.slice(2)) {
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

/** What a build printed, without the line that says it wrote the file and
 * the lines of that change. */
function diagnostics(stderr) {
  const lines = stderr.split("\n");
  const kept = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^scriptc: (?:recorded|updated) the Node island decision /.test(lines[i])) {
      while (i + 1 < lines.length && /^ {2}[+~-] /.test(lines[i + 1])) i++;
      continue;
    }
    kept.push(lines[i]);
  }
  return kept.join("\n");
}

async function sweepOne(entry, index) {
  const name = relative(root, entry);
  const work = join(options.out, "work", String(index));
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  const file = join(work, "islands.json");
  const ir = join(work, "program.ir");
  const env = { ...process.env, SCRIPTC_CACHE_DIR: join(work, "cache") };
  delete env.SCRIPTC_TIMING;
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
  rmSync(work, { recursive: true, force: true });
  return {
    name,
    code: recording.code,
    recorded: recordedFile !== null,
    packages,
    modules,
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
process.stdout.write(
  `${results.length} programs: ${results.filter((result) => result.recorded).length} recorded a decision ` +
    `(${withIslands.length} with an island), ${results.filter((result) => !result.recorded).length} stop before their lowering; ` +
    `${failed.length} differ\n` +
    `results: ${join(options.out, "results.jsonl")}\n`,
);
process.exit(failed.length === 0 ? 0 : 1);
