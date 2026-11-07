#!/usr/bin/env tsx
// The census of the builtins' throw decision.
//
// Every builtin (a key of libFnSignatures()) states once whether its runtime
// function can throw: a row in MAY_THROW_LIB_FNS
// (packages/compiler/src/ir/builtin-effects.ts) or in NEVER_THROW_LIB_FNS
// (packages/compiler/src/ir/builtin-never-throw.ts). The builtins that
// predate the rule and are in neither are listed in
// packages/compiler/src/ir/builtin-throw-undecided.txt. That list only
// shrinks: this script removes names from it and never adds one, and
// packages/compiler/test/builtin-attributes.test.ts fails on a builtin that
// is in none of the three.
//
// Usage:
//   pnpm exec tsx scripts/builtin-throw-census.mjs           print the census; exit 1 when it does not hold
//   pnpm exec tsx scripts/builtin-throw-census.mjs --prune   drop decided and deleted names from the undecided list
//
// Runs under tsx: it imports the compiler's TypeScript sources directly.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
export const UNDECIDED_FILE = "packages/compiler/src/ir/builtin-throw-undecided.txt";
const samePath = (a, b) => a.replace(/\\/g, "/") === b.replace(/\\/g, "/");

const HEADER = [
  "# Builtins with no throw decision: in neither MAY_THROW_LIB_FNS (builtin-effects.ts)",
  "# nor NEVER_THROW_LIB_FNS (builtin-never-throw.ts). They are compiled as non-throwing.",
  "# This list only shrinks. To decide one, read its runtime function, add the builtin to",
  "# one of the two sets and delete its line (pnpm exec tsx scripts/builtin-throw-census.mjs --prune).",
  "# Never add a line: a new builtin goes into one of the two sets.",
];

/** The names in the undecided list's text: one per line, `#` lines are
 * comments. */
export function parseUndecided(text) {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
}

/** The undecided list's text for `names`. */
export function renderUndecided(names) {
  return [...HEADER, ...[...new Set(names)].sort()].join("\n") + "\n";
}

/** The undecided list as it is checked in. */
export function readUndecided() {
  return parseUndecided(readFileSync(root + UNDECIDED_FILE, "utf8"));
}

/** Where each builtin's throw decision stands.
 *  - `missing`: builtins in no set and not in the undecided list;
 *  - `contradictory`: builtins in both sets;
 *  - `stale`: undecided names that were decided since, or name no builtin;
 *  - `unsorted`: whether the undecided list is out of order or repeats a name. */
export function throwCensus({ builtins, mayThrow, neverThrow, undecided }) {
  const known = new Set(builtins);
  const listed = new Set(undecided);
  return {
    missing: builtins.filter(
      (name) => !mayThrow.has(name) && !neverThrow.has(name) && !listed.has(name),
    ),
    contradictory: builtins.filter((name) => mayThrow.has(name) && neverThrow.has(name)),
    stale: undecided.filter(
      (name) => !known.has(name) || mayThrow.has(name) || neverThrow.has(name),
    ),
    unsorted: undecided.some((name, i) => i > 0 && undecided[i - 1] >= name),
  };
}

/** What the author of a builtin without a decision has to do. */
export function missingDecisionMessage(names) {
  return [
    `${names.length} builtin(s) do not say whether they can throw: ${names.join(", ")}.`,
    "Add each to exactly one set, one line per builtin:",
    "  - MAY_THROW_LIB_FNS (packages/compiler/src/ir/builtin-effects.ts) when its runtime function can raise an error",
    "    or run program code: a getter, toJSON, valueOf, toString, a proxy trap, a callback;",
    "  - NEVER_THROW_LIB_FNS (packages/compiler/src/ir/builtin-never-throw.ts) when it can do neither.",
    "A builtin in neither is compiled without the check that delivers its error: the caller reads a placeholder",
    "result (NULL for a pointer, 0 for a number) and the error is lost or surfaces somewhere else.",
    `Do not add it to ${UNDECIDED_FILE}: that list only shrinks.`,
  ].join("\n");
}

if (process.argv[1] !== undefined && samePath(process.argv[1], fileURLToPath(import.meta.url))) {
  const source = "../packages/compiler/src/";
  const { libFnSignatures } = await import(`${source}ir/builtin-signatures.ts`);
  const { MAY_THROW_LIB_FNS } = await import(`${source}ir/builtin-effects.ts`);
  const { NEVER_THROW_LIB_FNS } = await import(`${source}ir/builtin-never-throw.ts`);
  const { PURE_MATH_LIB_FNS } = await import(`${source}backend/llvm/lib-shared.ts`);
  const builtins = Object.keys(libFnSignatures());
  // A pure Math call is emitted `nounwind`: that is a never-throw decision.
  const neverThrow = new Set([...NEVER_THROW_LIB_FNS, ...PURE_MATH_LIB_FNS]);
  let undecided = readUndecided();
  let census = throwCensus({ builtins, mayThrow: MAY_THROW_LIB_FNS, neverThrow, undecided });
  if (process.argv.includes("--prune")) {
    const stale = new Set(census.stale);
    const kept = undecided.filter((name) => !stale.has(name));
    writeFileSync(root + UNDECIDED_FILE, renderUndecided(kept));
    console.log(`${UNDECIDED_FILE}: ${undecided.length} -> ${new Set(kept).size} names`);
    undecided = readUndecided();
    census = throwCensus({ builtins, mayThrow: MAY_THROW_LIB_FNS, neverThrow, undecided });
  }
  console.log(
    `${builtins.length} builtins: ${MAY_THROW_LIB_FNS.size} may throw, ${neverThrow.size} never throw, ${undecided.length} undecided`,
  );
  if (census.missing.length > 0) console.error(missingDecisionMessage(census.missing));
  if (census.contradictory.length > 0)
    console.error(`in both sets: ${census.contradictory.join(", ")}`);
  if (census.stale.length > 0)
    console.error(
      `decided or deleted, still in ${UNDECIDED_FILE} (run with --prune): ${census.stale.join(", ")}`,
    );
  if (census.unsorted) console.error(`${UNDECIDED_FILE} is not sorted (run with --prune)`);
  if (
    census.missing.length > 0 ||
    census.contradictory.length > 0 ||
    census.stale.length > 0 ||
    census.unsorted
  )
    process.exitCode = 1;
}
