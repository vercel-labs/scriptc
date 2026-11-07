/* Line reducer for a program that fails the lane's oracle.
 *
 * Deletes lines, largest chunks first, for as long as the program keeps
 * failing the same way: Node still runs it to the same exit status, the
 * build still succeeds, and the verdict is unchanged. A generated program of
 * sixty lines comes down to six to ten this way. A program that is refused,
 * or that crashes the compiler, reduces while its first diagnostic code
 * stays the same.
 *
 * Usage: node tests/harness/generative/reduce.mjs <program.ts> --out <reduced.ts>
 *          [--node-prints <text>] [--native-prints <text>]
 *
 * The verdict alone can be kept by a different bug than the one the program
 * started with (a reduction that empties an interface turns a silent copy
 * into a documented one). --node-prints keeps only candidates where Node's
 * stdout contains the text and the native stdout does not; --native-prints
 * keeps only candidates whose native output (stdout or stderr) contains the
 * text. Either pins the reduction to the difference that matters.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { differential, FAILURES, programDirectory, requireBuiltCompiler } from "./oracle.mjs";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: "string" },
    "node-prints": { type: "string" },
    "native-prints": { type: "string" },
  },
});
if (positionals.length !== 1 || values.out === undefined) {
  console.error(
    "usage: reduce.mjs <program.ts> --out <reduced.ts> [--node-prints <text>] [--native-prints <text>]",
  );
  process.exit(2);
}
requireBuiltCompiler();

const file = resolve(positionals[0]);
const workDir = programDirectory(mkdtempSync(join(tmpdir(), "scriptc-reduce-")));
const entry = join(workDir, `candidate${extname(file)}`);
const exe = join(workDir, "candidate.exe");

async function outcome(lines) {
  const text = lines.join("\n");
  writeFileSync(entry, text);
  return differential(entry, text, exe);
}

let lines = readFileSync(file, "utf8").split("\n");
const original = await outcome(lines);
if (!FAILURES.includes(original.verdict)) {
  console.error(`nothing to reduce: the program's verdict is '${original.verdict}'`);
  rmSync(workDir, { recursive: true, force: true });
  process.exit(1);
}

/** The diagnostic a failed build is recognized by. */
function buildFailure(result) {
  return result.built.errors[0] ?? "crash";
}

function stillFails(result) {
  if (result.verdict !== original.verdict) return false;
  // A program that does not build keeps failing when it is refused, or
  // crashes the compiler, with the same first diagnostic code.
  if (original.node === undefined) return buildFailure(result) === buildFailure(original);
  if (result.node === undefined || result.node.code !== original.node.code) return false;
  const nodePrints = values["node-prints"];
  if (
    nodePrints !== undefined &&
    !(result.node.stdout.includes(nodePrints) && !result.native.stdout.includes(nodePrints))
  ) {
    return false;
  }
  const nativePrints = values["native-prints"];
  if (
    nativePrints !== undefined &&
    !(result.native.stdout + result.native.stderr).includes(nativePrints)
  ) {
    return false;
  }
  return true;
}

if (!stillFails(original)) {
  console.error("the program does not satisfy --node-prints/--native-prints as given");
  rmSync(workDir, { recursive: true, force: true });
  process.exit(1);
}

let attempts = 0;
for (let changed = true; changed;) {
  changed = false;
  for (let chunk = Math.max(1, lines.length >> 2); chunk >= 1; chunk >>= 1) {
    for (let start = lines.length - chunk; start >= 0; start -= chunk) {
      const candidate = [...lines.slice(0, start), ...lines.slice(start + chunk)];
      if (candidate.length === 0) continue;
      attempts++;
      if (stillFails(await outcome(candidate))) {
        lines = candidate;
        changed = true;
      }
    }
  }
}

mkdirSync(dirname(resolve(values.out)), { recursive: true });
writeFileSync(resolve(values.out), lines.join("\n"));
rmSync(workDir, { recursive: true, force: true });
console.log(
  `${original.verdict}: reduced to ${lines.length} lines in ${attempts} builds, written to ${values.out}`,
);
