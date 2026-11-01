/* The host-global table is derived from the compatibility ledger, never
 * typed by hand: a read of a Node 24 global the native runtime does not
 * implement refuses (SC2020, reason "host-global") instead of answering
 * undefined. This test recomputes the derivation and pins the table. */
import { globSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { NODE_GLOBALS_WITHOUT_NATIVE } from "../src/frontend/lowering/host-globals.js";
import { COMMONJS_MODULE_BINDINGS } from "../src/frontend/builtin-modules.js";

const repoRoot = join(import.meta.dirname, "../../..");
const read = (path: string): string => readFileSync(join(repoRoot, path), "utf8");

interface LedgerRow {
  chapter: string;
  depth: number;
  name?: string;
  nodeStability?: { text?: string };
  static?: { status?: string };
}

/** Node 24 dispatches these only behind a flag (the stability note names
 * the flag), so they are not default globals and a probe for them is a
 * genuine absent-capability probe. */
function flagGated(row: LedgerRow): boolean {
  return /Enable this API with/.test(row.nodeStability?.text ?? "");
}

/** Global names the compiler's bundled declarations know: a read of one is
 * either lowered or a loud runtime SC2020, never a silent undefined. */
function declaredGlobals(): Set<string> {
  const names = new Set<string>();
  for (const file of globSync(join(repoRoot, "packages/compiler/ambient/**/*.d.ts"))) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(
      /^declare (?:var|const|let|class|function|namespace) ([A-Za-z_$][\w$]*)/gm,
    ))
      names.add(match[1]!);
  }
  return names;
}

test("NODE_GLOBALS_WITHOUT_NATIVE is the ledger's derived set", () => {
  const pin = JSON.parse(read("internal/compatibility/node-v24.json")) as { version: string };
  const ledger = JSON.parse(read("internal/compatibility/generated/node-v24-internal.json")) as {
    nodeVersion: string;
    rows: LedgerRow[];
  };
  expect(ledger.nodeVersion).toBe(pin.version);

  const declared = declaredGlobals();
  const derived = new Set(
    ledger.rows
      .filter(
        (row) =>
          row.chapter === "globals" &&
          row.depth === 1 &&
          row.name !== undefined &&
          !flagGated(row) &&
          row.static?.status === "not-implemented",
      )
      .map((row) => String(row.name).replace(/`/g, ""))
      .filter((name) => !declared.has(name) && !COMMONJS_MODULE_BINDINGS.has(name)),
  );

  // Performance is a Node 24 global the docs' globals chapter omits (Node
  // documents the class under perf_hooks, which has no Performance row
  // either). The design repro's runtime probe pins it as a global whose
  // typeof is "function", so it is the table's one documented extra.
  derived.add("Performance");

  expect([...NODE_GLOBALS_WITHOUT_NATIVE].sort()).toEqual([...derived].sort());
});
