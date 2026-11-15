/* The generative and metamorphic lanes.
 *
 * Both look for programs that compile and then behave differently from Node
 * with no diagnostic. The corpus pins the shapes someone thought to write;
 * these lanes make shapes nobody wrote.
 *
 *   generate     runs programs from the seeded generators (generators.mjs).
 *   metamorphic  applies meaning-preserving rewrites (rewrites.mjs) to corpus
 *                programs that match Node, and requires each rewritten
 *                program to build and match Node too.
 *
 * Usage:
 *   node tests/harness/generative/run.mjs generate [--generators records,numbers,islands]
 *        [--seed 1] [--count 200] [--from 0]
 *   node tests/harness/generative/run.mjs metamorphic [--programs a.ts,b.ts]
 *        [--stride 11 [--offset 2]] [--rewrites id,unknown,...]
 *   node tests/harness/generative/run.mjs emit <generator> <seed> <index> [<out dir>]
 *   node tests/harness/generative/run.mjs rewrite <corpus program> <rewrite> <out dir>
 *   node tests/harness/generative/run.mjs scoreboard
 *
 * Options for the two lanes:
 *   --jobs <n>         programs in flight (default: cores - 1)
 *   --baseline <file>  known failures (default: baseline.json beside this file)
 *   --no-baseline      report every failure and exit 0
 *   --record           replace the baseline's entries for what this run covers
 *   --keep <dir>       where failing programs and their outputs are left
 *                      (default: .scriptc/generative)
 *
 * The lanes fail today, so they do not gate pull requests. baseline.json
 * lists every known failure: by generator, seed and index, or by corpus
 * program and rewrite. A run exits 1 for a failure the baseline does not
 * list, for one whose category changed, and for a listed failure that now
 * passes (delete its entry), so the baseline shrinks as fixes land and never
 * hides a new failure. `scoreboard` prints its size by category.
 *
 * The metamorphic lane rewrites the corpus programs the baseline lists
 * under `programs`, so a program added to the corpus does not change what a
 * nightly run covers. --stride picks every nth corpus program instead (to
 * explore, or with --record to choose the list again), and --programs names
 * them.
 *
 * A generated failure is reproduced from its key: `emit records 1 17` prints
 * the program `records/1/0017` names. `rewrite 8764-x.ts id out/` writes the
 * variant `8764-x.ts/id` names. reduce.mjs then shrinks either one.
 *
 * Needs a built workspace (pnpm install && pnpm -r build). The `islands`
 * generator's programs call into a Node island: they run only when
 * SCRIPTC_LIBNODE names a libnode pack, and they resolve @scriptc/node from
 * where they are written, so --keep has to stay inside the repository for
 * them.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { generate, generatorDigest, generators, needsLibnode } from "./generators.mjs";
import {
  build,
  describeRun,
  differential,
  FAILURES,
  firstDiagnostic,
  pool,
  programDirectory,
  recordGeneratorDigests,
  repoRoot,
  requireBuiltCompiler,
  runBoth,
  sameRun,
  verdictOf,
} from "./oracle.mjs";
import { rewrites } from "./rewrites.mjs";

const defaultBaseline = join(repoRoot, "tests/harness/generative/baseline.json");
const corpusDir = join(repoRoot, "tests/corpus");

const { values: options, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    generators: { type: "string", default: Object.keys(generators).join(",") },
    seed: { type: "string", default: "1" },
    count: { type: "string", default: "200" },
    from: { type: "string", default: "0" },
    stride: { type: "string" },
    offset: { type: "string", default: "0" },
    programs: { type: "string" },
    rewrites: { type: "string", default: Object.keys(rewrites).join(",") },
    jobs: { type: "string", default: String(Math.max(1, availableParallelism() - 1)) },
    baseline: { type: "string", default: defaultBaseline },
    "no-baseline": { type: "boolean", default: false },
    record: { type: "boolean", default: false },
    // Not under node_modules, where Node refuses to strip types, and inside
    // the repository, where island programs resolve @scriptc/node.
    keep: { type: "string", default: join(repoRoot, ".scriptc/generative") },
  },
});
const [command, ...operands] = positionals;

function readBaseline() {
  const file = resolve(options.baseline);
  const empty = { digests: {}, programs: [], generate: {}, metamorphic: {} };
  return existsSync(file) ? { ...empty, ...JSON.parse(readFileSync(file, "utf8")) } : empty;
}

function writeBaseline(baseline) {
  const sorted = (entries) =>
    Object.fromEntries(Object.entries(entries).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  const ordered = {
    digests: sorted(baseline.digests),
    programs: [...new Set(baseline.programs)].sort(),
    generate: sorted(baseline.generate),
    metamorphic: sorted(baseline.metamorphic),
  };
  writeFileSync(resolve(options.baseline), `${JSON.stringify(ordered, null, 2)}\n`);
}

function tally(counts, key) {
  counts[key] = (counts[key] ?? 0) + 1;
}

function formatCounts(counts) {
  const names = Object.keys(counts).sort();
  return names.length === 0 ? "nothing" : names.map((name) => `${name} ${counts[name]}`).join(", ");
}

/** Compares what a lane observed with the baseline section it owns, records
 * the result when asked, and answers the process exit status. `observed`
 * maps each failing key to its category; `covers` says which baseline keys
 * this run was able to observe. */
function settle(lane, observed, covers, reproduce, recordMore = () => {}) {
  const baseline = readBaseline();
  const known = baseline[lane];
  if (options.record) {
    for (const key of Object.keys(known)) if (covers(key)) delete known[key];
    Object.assign(known, observed);
    recordMore(baseline);
    writeBaseline(baseline);
    console.log(`recorded ${Object.keys(observed).length} ${lane} failures in ${options.baseline}`);
    return 0;
  }
  if (options["no-baseline"]) {
    for (const [key, category] of Object.entries(observed)) console.log(`${category}  ${key}`);
    return 0;
  }
  const fresh = [];
  const changed = [];
  const fixed = [];
  for (const [key, category] of Object.entries(observed)) {
    if (known[key] === undefined) fresh.push(`${category}  ${key}`);
    else if (known[key] !== category) changed.push(`${known[key]} -> ${category}  ${key}`);
  }
  for (const key of Object.keys(known)) {
    if (covers(key) && observed[key] === undefined) fixed.push(`${known[key]}  ${key}`);
  }
  const listed = Object.keys(observed).length - fresh.length - changed.length;
  console.log(
    `baseline: ${listed} known, ${fresh.length} new, ${changed.length} changed, ${fixed.length} fixed`,
  );
  const report = (title, rows) => {
    if (rows.length === 0) return;
    console.log(`\n${title}`);
    for (const row of rows) console.log(`  ${row}`);
  };
  report("New failures (not in the baseline):", fresh);
  report("Failures whose category changed:", changed);
  report("Listed failures that now pass (delete them from the baseline):", fixed);
  if (fresh.length + changed.length > 0) {
    console.log(`\nFailing programs and their outputs are under ${options.keep}.\n${reproduce}`);
  }
  return fresh.length + changed.length + fixed.length > 0 ? 1 : 0;
}

/** Writes what a failing program printed beside it. */
function keepEvidence(prefix, result) {
  if (result.node !== undefined) {
    writeFileSync(`${prefix}.node.txt`, describeRun(result.node));
    writeFileSync(`${prefix}.native.txt`, describeRun(result.native));
  }
  if (result.built !== undefined && (result.node === undefined || result.built.warnings.length > 0))
    writeFileSync(`${prefix}.build.txt`, result.built.text);
}

/* ── generate ──────────────────────────────────────────────────────────── */

function generatedKey(generator, seed, index) {
  return `${generator}/${seed}/${String(index).padStart(4, "0")}`;
}

async function runGenerate() {
  requireBuiltCompiler();
  const seed = Number(options.seed);
  const from = Number(options.from);
  const count = Number(options.count);
  // Island programs load Node from a libnode pack. Without one they are left
  // out, and their baseline entries are neither confirmed nor called fixed.
  const hasLibnode = (process.env["SCRIPTC_LIBNODE"] ?? "") !== "";
  const names = options.generators.split(",").filter((name) => {
    if (generators[name] === undefined) throw new Error(`unknown generator '${name}'`);
    if (!needsLibnode.has(name) || hasLibnode) return true;
    console.log(`skipping the '${name}' generator: SCRIPTC_LIBNODE names no libnode pack`);
    return false;
  });
  const baseline = readBaseline();
  if (!options.record && !options["no-baseline"]) {
    for (const name of names) {
      const recorded = baseline.digests[name];
      if (recorded !== undefined && recorded !== generatorDigest(name)) {
        throw new Error(
          `the '${name}' generator changed since ${options.baseline} was recorded: its keys name other programs now. Run this lane with --record and review the difference.`,
        );
      }
    }
  }
  const workDir = join(resolve(options.keep), "generate");
  rmSync(workDir, { recursive: true, force: true });
  programDirectory(workDir);
  const tasks = names.flatMap((generator) =>
    Array.from({ length: count }, (_, i) => ({ generator, index: from + i })),
  );
  const counts = {};
  const observed = {};
  let done = 0;
  await pool(tasks, Number(options.jobs), async ({ generator, index }) => {
    const key = generatedKey(generator, seed, index);
    const directory = join(workDir, key.replaceAll("/", "-"));
    const files = generate(generator, seed, index);
    mkdirSync(directory, { recursive: true });
    for (const [name, text] of Object.entries(files)) writeFileSync(join(directory, name), text);
    const entry = join(directory, "main.ts");
    const result = await differential(entry, files["main.ts"], join(directory, "main.exe"));
    tally(counts, `${generator}: ${result.verdict}`);
    // A generator that emits a program tsc rejects is itself at fault, and
    // that has to be as visible as a failure of the compiler.
    if (FAILURES.includes(result.verdict) || result.verdict === "type-error") {
      observed[key] = result.verdict;
      keepEvidence(join(directory, "main"), result);
    } else {
      rmSync(directory, { recursive: true, force: true });
    }
    if (++done % 50 === 0) console.log(`${done}/${tasks.length}: ${formatCounts(counts)}`);
  });
  console.log(`generate, seed ${seed}, programs ${from}..${from + count - 1}`);
  console.log(`  ${formatCounts(counts)}`);
  const covers = (key) => {
    const [generator, keySeed, index] = key.split("/");
    return (
      names.includes(generator) &&
      Number(keySeed) === seed &&
      Number(index) >= from &&
      Number(index) < from + count
    );
  };
  return settle(
    "generate",
    observed,
    covers,
    "Write one again with: node tests/harness/generative/run.mjs emit <generator> <seed> <index> [<out dir>]",
    // The digests of the generators this run ran, and of no other: a
    // generator left out (islands without a libnode pack) keeps its digest,
    // and the metamorphic lane records none.
    (baseline) => recordGeneratorDigests(baseline, names, observed, generatorDigest),
  );
}

/* ── metamorphic ───────────────────────────────────────────────────────── */

/** The corpus programs a run rewrites: the ones --programs names, every
 * --stride'th single-file TypeScript program, or by default the list the
 * baseline was recorded over. */
function corpusPrograms() {
  const all = readdirSync(corpusDir)
    .filter((name) => name.endsWith(".ts"))
    .sort();
  if (options.programs !== undefined) {
    const wanted = options.programs.split(",").map((name) => basename(name));
    for (const name of wanted) {
      if (!all.includes(name)) throw new Error(`tests/corpus/${name} is not a corpus program`);
    }
    return wanted;
  }
  if (options.stride !== undefined) {
    const stride = Number(options.stride);
    const offset = Number(options.offset);
    return all.filter((_, i) => i % stride === offset % stride);
  }
  const listed = readBaseline().programs;
  if (listed.length === 0) {
    throw new Error("the baseline lists no programs: name some with --programs or --stride");
  }
  // A listed program that left the corpus is not this lane's failure.
  return listed.filter((name) => all.includes(name));
}

/** Why the lane cannot move a program: a harness directive (its oracle
 * needs the corpus harness) or a relative path (the variant is built in
 * another directory). */
function movable(source) {
  if (source.split("\n", 2).some((line) => line.startsWith("// @"))) return "directive";
  if (/["'`]\.\.?\//.test(source)) return "relative path";
  return null;
}

/** Builds and runs one variant against the original program's Node run. */
async function runVariant(directory, files, original) {
  mkdirSync(directory, { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(directory, name), text);
  const entry = join(directory, "main.ts");
  const exe = join(directory, "main.exe");
  const built = await build(entry, exe);
  if (!built.ok) {
    if (built.internal) return { verdict: "internal-error", built };
    // tsc rejects the rewritten program: not a valid variant.
    if (built.errors.includes("SC0001")) return { verdict: "invalid", built };
    return { verdict: "refused", built };
  }
  const { node, native } = await runBoth(entry, files["main.ts"], exe);
  rmSync(exe, { force: true });
  // The rewrite changed what Node prints (a stack trace, a file name): it
  // did not preserve this program's meaning.
  if (!sameRun(node, original)) return { verdict: "not-preserving", built, node, native };
  return { verdict: verdictOf(built, node, native), built, node, native };
}

async function runMetamorphic() {
  requireBuiltCompiler();
  const names = options.rewrites.split(",");
  for (const name of names) {
    if (rewrites[name] === undefined) throw new Error(`unknown rewrite '${name}'`);
  }
  const programs = corpusPrograms();
  const workDir = join(resolve(options.keep), "metamorphic");
  rmSync(workDir, { recursive: true, force: true });
  programDirectory(workDir);
  const failing = [...FAILURES, "warned-diff"];
  const counts = {};
  const skipped = {};
  const observed = {};
  const considered = new Set();
  let done = 0;
  await pool(programs, Number(options.jobs), async (program) => {
    const file = join(corpusDir, program);
    const source = readFileSync(file, "utf8");
    const stem = program.replace(/\.ts$/, "");
    const why = movable(source);
    if (why !== null) {
      tally(skipped, why);
    } else {
      const original = await differential(file, source, join(workDir, `${stem}.exe`));
      if (original.verdict !== "match") {
        tally(skipped, `the program itself: ${original.verdict}`);
      } else {
        considered.add(program);
        for (const name of names) {
          const variant = rewrites[name](source, program);
          if (variant === null) {
            tally(counts, `${name}: not applicable`);
            continue;
          }
          const directory = join(workDir, `${stem}.${name}`);
          const result = await runVariant(directory, variant.files, original.node);
          tally(counts, `${name}: ${result.verdict}`);
          if (failing.includes(result.verdict)) {
            observed[`${program}/${name}`] = result.verdict;
            keepEvidence(join(directory, "main"), result);
            if (result.node === undefined) {
              writeFileSync(
                join(directory, "main.first-diagnostic.txt"),
                firstDiagnostic(result.built),
              );
            }
          } else {
            rmSync(directory, { recursive: true, force: true });
          }
        }
      }
    }
    if (++done % 25 === 0) console.log(`${done}/${programs.length} programs`);
  });
  console.log(`metamorphic, ${programs.length} corpus programs, ${considered.size} match Node`);
  if (Object.keys(skipped).length > 0) console.log(`  skipped: ${formatCounts(skipped)}`);
  for (const name of names) {
    const own = Object.fromEntries(
      Object.entries(counts)
        .filter(([key]) => key.startsWith(`${name}: `))
        .map(([key, value]) => [key.slice(name.length + 2), value]),
    );
    console.log(`  ${name}: ${formatCounts(own)}`);
  }
  // A listed failure whose program was skipped or no longer matches Node was
  // not observed; only a variant that ran and passed counts as fixed.
  const covers = (key) => {
    const cut = key.lastIndexOf("/");
    return considered.has(key.slice(0, cut)) && names.includes(key.slice(cut + 1));
  };
  return settle(
    "metamorphic",
    observed,
    covers,
    "Write one again with: node tests/harness/generative/run.mjs rewrite <corpus program> <rewrite> <out dir>",
    (baseline) => {
      // A run over a chosen sample replaces the list; one over named
      // programs adds them to it.
      baseline.programs =
        options.programs === undefined ? programs : [...baseline.programs, ...programs];
    },
  );
}

/* ── single programs and the scoreboard ────────────────────────────────── */

function emit() {
  const [generator, seed, index, outDir] = operands;
  if (index === undefined) {
    throw new Error("usage: run.mjs emit <generator> <seed> <index> [<out dir>]");
  }
  const files = generate(generator, Number(seed), Number(index));
  if (outDir === undefined) {
    if (Object.keys(files).length > 1) {
      throw new Error(
        `a '${generator}' program has several files: name a directory to write them to`,
      );
    }
    process.stdout.write(files["main.ts"]);
    return;
  }
  mkdirSync(resolve(outDir), { recursive: true });
  for (const [name, text] of Object.entries(files))
    writeFileSync(join(resolve(outDir), name), text);
  console.log(`${Object.keys(files).join(", ")} written to ${outDir}`);
}

function rewriteOne() {
  const [program, name, outDir] = operands;
  if (outDir === undefined) {
    throw new Error("usage: run.mjs rewrite <corpus program> <rewrite> <out dir>");
  }
  if (rewrites[name] === undefined) throw new Error(`unknown rewrite '${name}'`);
  const file = existsSync(program) ? program : join(corpusDir, basename(program));
  const variant = rewrites[name](readFileSync(file, "utf8"), basename(file));
  if (variant === null) throw new Error(`the '${name}' rewrite does not apply to ${file}`);
  mkdirSync(resolve(outDir), { recursive: true });
  for (const [fileName, text] of Object.entries(variant.files)) {
    writeFileSync(join(resolve(outDir), fileName), text);
  }
  console.log(
    `${Object.keys(variant.files).join(", ")} written to ${outDir} (${variant.sites} sites)`,
  );
}

function scoreboard() {
  const baseline = readBaseline();
  for (const lane of ["generate", "metamorphic"]) {
    const counts = {};
    for (const [key, category] of Object.entries(baseline[lane])) {
      const group = lane === "generate" ? key.split("/")[0] : key.slice(key.lastIndexOf("/") + 1);
      tally(counts, category);
      tally(counts, `${category} (${group})`);
    }
    console.log(`${lane}: ${Object.keys(baseline[lane]).length} known failures`);
    for (const name of Object.keys(counts).sort()) console.log(`  ${name}: ${counts[name]}`);
  }
}

const commands = {
  generate: runGenerate,
  metamorphic: runMetamorphic,
  emit,
  rewrite: rewriteOne,
  scoreboard,
};
if (commands[command] === undefined) {
  console.error(
    "usage: run.mjs generate|metamorphic|emit|rewrite|scoreboard (see the header of this file)",
  );
  process.exit(2);
}
try {
  process.exitCode = (await commands[command]()) ?? 0;
} catch (error) {
  // A wrong argument or a stale baseline: say what is wrong, without a stack.
  console.error(`run.mjs ${command}: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 2;
}
