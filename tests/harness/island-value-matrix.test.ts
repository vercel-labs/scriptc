/* The Node island value-crossing matrix: how every kind of value crosses
 * between native code and a Node island, pinned observation by observation.
 *
 * island-value-matrix/matrix.ts generates one program per (kind of value,
 * typing): it crosses the value in every direction (as an argument, as a
 * return value, there and back, through closures the other side calls) and
 * prints one labelled line per observation — a read, a write seen from the
 * other side, identity after a round trip, key order, JSON.stringify,
 * structuredClone, instanceof, typeof, mutation during iteration. Each
 * program runs under Node, where the island package is an ordinary package,
 * and as a native binary whose island package runs in the embedded Node.
 *
 * island-value-matrix/expected.json pins every observation that is not a
 * match: a named compiler refusal with its code, a native error where Node
 * answers, a silent wrong answer, a crash. A control program per kind makes
 * and observes the value with no island at all, so the table shows which
 * differences are the boundary's and which the native tier has on its own.
 * The table is the state of the crossing rule: a change to the rule shows
 * as a diff of it. After such a change, regenerate it with
 *
 *   SCRIPTC_ISLAND_MATRIX=update pnpm vitest run tests/harness/island-value-matrix.test.ts
 *
 * (unsharded, with a libnode pack in SCRIPTC_LIBNODE) and review the diff:
 * an entry that disappears is a fix, a new one is a regression or a new
 * refusal. SCRIPTC_ISLAND_MATRIX_FILTER=<regex> narrows a run to the
 * programs whose id (`<kind>.<typing>`, `<kind>.control.-`) matches.
 *
 * Needs a libnode pack in SCRIPTC_LIBNODE (libnode.ts). */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { libnodePack } from "./libnode.js";
import { shardSelect } from "./shard.js";
import { generateGroups } from "./island-value-matrix/matrix.js";
import { pin, runProgram } from "./island-value-matrix/runner.js";

// Outside every node_modules directory: Node runs the generated programs
// with its own type stripping, which it refuses for files under one.
const outDir = mkdtempSync(join(tmpdir(), "scriptc-island-value-matrix-"));
const expectedPath = join(import.meta.dirname, "island-value-matrix/expected.json");
const sanitize = process.env["SCRIPTC_SAN"] === "1";
const update = process.env["SCRIPTC_ISLAND_MATRIX"] === "update";
const filter = new RegExp(process.env["SCRIPTC_ISLAND_MATRIX_FILTER"] ?? ".");
const skip = libnodePack() === null;

type Table = Record<string, Record<string, string>>;
const expected = JSON.parse(readFileSync(expectedPath, "utf8")) as Table;
const actual: Table = {};

/** Statuses of lines the native program dies on. Such a line is left out
 * of the program from the start: finding it again takes a rebuild, and what
 * the compiler says about the lines that use its binding depends on whether
 * it is there. */
const FATAL = new Set(["crash", "hang", "exit"]);

const programs = generateGroups().filter((cell) => filter.test(cell.id));

/** The table of one program with the lines `known` records as fatal left
 * out. An update starts with none and adds the ones each run finds, until a
 * run finds no more: the table it records is then the one a pinned run
 * computes. */
async function tableOf(
  cell: (typeof programs)[number],
  known: Record<string, string>,
): Promise<Record<string, string>> {
  const fatal = new Map(Object.entries(known).filter(([, status]) => FATAL.has(status)));
  for (let round = 0; ; round++) {
    const result = await runProgram(cell, {
      dir: join(outDir, cell.id),
      sanitize,
      drop: new Set(fatal.keys()),
    });
    expect(result.failure, cell.id).toBeNull();
    const table: Record<string, string> = {};
    for (const [label, o] of Object.entries(result.observations))
      table[label] = fatal.get(label) ?? pin(o);
    const found = Object.keys(table).filter((l) => FATAL.has(table[l]!) && !fatal.has(l));
    if (!update || found.length === 0 || round === 8) return table;
    for (const label of found) fatal.set(label, table[label]!);
  }
}

describe.skipIf(skip)("Node island value-crossing matrix", () => {
  for (const cell of shardSelect(programs, (c) => c.id)) {
    test.concurrent(
      cell.id,
      async () => {
        const pinned = expected[cell.id] ?? {};
        const table = await tableOf(cell, update ? {} : pinned);
        actual[cell.id] = table;
        if (!update) expect(table).toEqual(pinned);
      },
      1_800_000,
    );
  }

  afterAll(() => {
    rmSync(outDir, { recursive: true, force: true });
    if (!update) return;
    // A filtered update rewrites only the programs it ran.
    const next: Table = { ...expected, ...actual };
    const sorted: Table = {};
    for (const id of Object.keys(next).sort()) sorted[id] = next[id]!;
    writeFileSync(expectedPath, JSON.stringify(sorted, null, 1) + "\n");
  });
});
