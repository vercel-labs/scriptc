#!/usr/bin/env node
/* Diff two LLVM modules of the same program with every generated symbol
 * name normalized, so that a change meant only to rename backend helpers
 * (sc_<family>_<n> -> content-keyed names, and the reverse) shows an empty
 * diff, and anything else — an instruction, a type, a definition order, a
 * comment — shows up.
 *
 * Normalization rewrites `@?sc_<family>_<digits>` to `sc_<family>_N` in
 * both files, keeping any suffix the name derives (`_lens`, `_data`,
 * `_materialize`). Everything else compares byte for byte, including the
 * module-local metadata ids the helper renumbers per partition.
 *
 * Usage: node scripts/llvm-name-normalized-diff.mjs <a.ll> <b.ll>
 *          [--max-report <n>]   differing lines to print (default 20)
 * Exit status: 0 empty diff, 1 differences, 2 usage or read error.
 */
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

const NAME = /(?<![0-9A-Za-z_$.-])(@?)sc_([a-z_]+)_([0-9]{1,20})/g;

function normalize(line) {
  return line.replace(NAME, (_match, _sigil, family) => `sc_${family}_N`);
}

function lines(path) {
  return createInterface({
    input: createReadStream(path, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
}

async function main() {
  const args = process.argv.slice(2);
  const paths = [];
  let maxReport = 20;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--max-report") maxReport = Number(args[++i]);
    else paths.push(args[i]);
  }
  if (paths.length !== 2) {
    process.stderr.write(
      "usage: node scripts/llvm-name-normalized-diff.mjs <a.ll> <b.ll> [--max-report <n>]\n",
    );
    return 2;
  }
  const [a, b] = paths;
  const left = lines(a)[Symbol.asyncIterator]();
  const right = lines(b)[Symbol.asyncIterator]();
  let lineNumber = 0;
  let differences = 0;
  for (;;) {
    const [x, y] = await Promise.all([left.next(), right.next()]);
    if (x.done && y.done) break;
    lineNumber++;
    const leftText = x.done ? "<end of file>" : normalize(x.value);
    const rightText = y.done ? "<end of file>" : normalize(y.value);
    if (leftText !== rightText) {
      differences++;
      if (differences <= maxReport) {
        process.stdout.write(`${a}:${lineNumber} ${leftText}\n${b}:${lineNumber} ${rightText}\n\n`);
      }
    }
  }
  if (differences === 0) {
    process.stdout.write(`identical modulo generated names: ${a} == ${b}\n`);
    return 0;
  }
  process.stdout.write(`${differences} differing lines (${a} vs ${b})\n`);
  return 1;
}

process.exitCode = await main();
