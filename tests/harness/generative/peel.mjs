/* Refusal peeler: turns a probe scriptc refuses into a usable differential.
 *
 * One refused line hides everything else a hand-written probe checks. This
 * blanks each line a diagnostic names, rebuilds until the program compiles,
 * and then runs what is left under Node and natively. Lines that depended on
 * a blanked one are named by the next round's type errors and go the same
 * way, so the loop converges on the part of the probe scriptc accepts.
 *
 * Usage: node tests/harness/generative/peel.mjs <program.ts> [--out <peeled.ts>] [--rounds <n>]
 *
 * Prints the blanked lines with their diagnostics, then the verdict of the
 * oracle (oracle.mjs) and, for a mismatch, both outputs. Exits 1 when the
 * peeled program fails the oracle or never compiles.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  build,
  describeRun,
  FAILURES,
  firstDiagnostic,
  programDirectory,
  requireBuiltCompiler,
  runBoth,
  verdictOf,
} from "./oracle.mjs";

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Peels `source` (the text of a single-file program) inside `workDir`.
 * Answers the peeled text, the blanked lines and the verdict; `verdict` is
 * `stuck` when a round names no line that is still there to blank. */
export async function peel(source, { workDir, extension = ".ts", rounds = 25 }) {
  const entry = join(workDir, `peeled${extension}`);
  const exe = join(workDir, "peeled.exe");
  const lines = source.split("\n");
  const blanked = [];
  const located = new RegExp(
    `${escapeRegExp(entry)}:(\\d+):\\d+ - error (SC\\d{4}): ([^\\n]*)`,
    "g",
  );
  for (let round = 0; round <= rounds; round++) {
    writeFileSync(entry, lines.join("\n"));
    const built = await build(entry, exe);
    if (built.ok) {
      const text = lines.join("\n");
      const { node, native } = await runBoth(entry, text, exe);
      rmSync(exe, { force: true });
      return { text, blanked, verdict: verdictOf(built, node, native), built, node, native };
    }
    const named = new Map();
    for (const match of built.text.matchAll(located)) {
      const line = Number(match[1]);
      if (!named.has(line)) named.set(line, `${match[2]}: ${match[3].slice(0, 160)}`);
    }
    let progressed = false;
    for (const [line, why] of named) {
      const current = lines[line - 1];
      if (current === undefined || current.startsWith("// peeled ")) continue;
      blanked.push({ line, why, source: current });
      lines[line - 1] = `// peeled ${why}`;
      progressed = true;
    }
    if (!progressed) {
      const verdict = built.internal ? "internal-error" : "stuck";
      return { text: lines.join("\n"), blanked, verdict, built };
    }
  }
  return { text: lines.join("\n"), blanked, verdict: "stuck" };
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { out: { type: "string" }, rounds: { type: "string", default: "25" } },
  });
  if (positionals.length !== 1) {
    console.error("usage: peel.mjs <program.ts> [--out <peeled.ts>] [--rounds <n>]");
    process.exit(2);
  }
  requireBuiltCompiler();
  const file = resolve(positionals[0]);
  const workDir = programDirectory(mkdtempSync(join(tmpdir(), "scriptc-peel-")));
  try {
    const result = await peel(readFileSync(file, "utf8"), {
      workDir,
      extension: extname(file),
      rounds: Number(values.rounds),
    });
    for (const { line, why, source } of result.blanked) {
      console.log(`peeled line ${line}: ${why}\n    ${source.trim().slice(0, 160)}`);
    }
    if (values.out !== undefined) {
      mkdirSync(dirname(resolve(values.out)), { recursive: true });
      writeFileSync(resolve(values.out), result.text);
    }
    console.log(`verdict: ${result.verdict} (${result.blanked.length} lines peeled)`);
    if (result.verdict === "stuck" || result.verdict === "internal-error") {
      if (result.built !== undefined) console.log(firstDiagnostic(result.built));
      process.exitCode = 1;
    } else if (result.verdict !== "match") {
      console.log(`[node]\n${describeRun(result.node)}\n[native]\n${describeRun(result.native)}`);
      if (FAILURES.includes(result.verdict)) process.exitCode = 1;
    }
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
