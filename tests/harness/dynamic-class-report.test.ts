import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { budgetVerdict, dynamicClassReport } from "../../scripts/self-compile-budget.mjs";

/* SCRIPTC_DYNAMIC_CLASSES makes a build say where the named classes become
 * dynamic values (frontend/lowering/dynamic-class-report.ts), and the
 * self-compile budget fails on such a place (scripts/self-compile-budget.mjs,
 * neverDynamicClasses). The programs here are the shape that put the
 * compiler's Lowerer in the dynamic tier of its own build: a class instance
 * handed over where an interface with a method is declared. */

const repoRoot = join(import.meta.dirname, "../..");
const cli = join(repoRoot, "packages/cli/dist/main.js");

const HANDED_OVER = `interface Scope {
  lookup(name: string): number;
}
class Table {
  private readonly values = new Map<string, number>([["a", 1]]);
  lookup(name: string): number {
    return this.values.get(name) ?? 0;
  }
}
class Ledger {
  total = 0;
}
function read(scope: Scope, name: string): number {
  return scope.lookup(name);
}
const table = new Table();
const ledger = new Ledger();
ledger.total += read(table, "a");
console.log(ledger.total);
`;

/** The same program with the parameter typed as the class. */
const TYPED = HANDED_OVER.replace("scope: Scope", "scope: Table");

function build(source: string, classes: string | null): { status: number | null; stderr: string } {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-dynamic-classes-"));
  try {
    const entry = join(directory, "main.ts");
    writeFileSync(entry, source);
    const env: NodeJS.ProcessEnv = { ...process.env, SCRIPTC_NO_CACHE: "1" };
    delete env["SCRIPTC_DYNAMIC_CLASSES"];
    if (classes !== null) env["SCRIPTC_DYNAMIC_CLASSES"] = classes;
    const result = spawnSync(
      process.execPath,
      [cli, "build", entry, "--emit=ir", "-o", join(directory, "main.ir")],
      { encoding: "utf8", env, cwd: directory },
    );
    return { status: result.status, stderr: result.stderr.replaceAll(directory, "<dir>") };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const budget = {
  schema: 1,
  heapLimitMb: { value: 8192, reason: "the limit" },
  loweringPasses: { value: ["reachable-emit"], reason: "one pass" },
  liveHeapBytesPerSourceByte: { value: 200, reason: "recorded" },
  neverDynamicClasses: { value: ["Table", "Ledger"], reason: "the fixture's classes" },
};
const judge = (stderr: string) =>
  budgetVerdict({
    budget,
    trace: { passes: ["reachable-emit"], liveHeapMb: 1000 },
    bytes: 5 * 2 ** 20,
    dynamicClasses: dynamicClassReport(stderr),
    root: "<dir>/",
  });

test("a build names the place that makes a watched class a dynamic value", () => {
  const { status, stderr } = build(HANDED_OVER, "Table,Ledger");
  expect(status, stderr).toBe(0);
  const report = dynamicClassReport(stderr);
  expect(report?.names).toEqual(["Table", "Ledger"]);
  // The call that hands the Table over, and nothing about the Ledger.
  expect(report?.sites.map((site: { name: string }) => site.name)).toContain("Table");
  expect(report?.sites.map((site: { name: string }) => site.name)).not.toContain("Ledger");
  expect(report?.sites).toContainEqual(
    expect.objectContaining({
      name: "Table",
      kind: "dynamic",
      file: "<dir>/main.ts",
      line: 18,
      text: 'ledger.total += read(table, "a");',
    }),
  );
  const verdict = judge(stderr);
  expect(verdict.failures).toHaveLength(1);
  expect(verdict.failures[0]).toMatch(
    /Table must not be a dynamic value in the compiler's own build[^]*\n {2}main\.ts:18:\d+: a Table becomes a dynamic value {2}\| {2}ledger\.total \+= read\(table, "a"\);/,
  );
});

test("the same program with the class as the parameter's type reports no place", () => {
  const { status, stderr } = build(TYPED, "Table,Ledger");
  expect(status, stderr).toBe(0);
  expect(dynamicClassReport(stderr)).toEqual({ names: ["Table", "Ledger"], sites: [] });
  const verdict = judge(stderr);
  expect(verdict.failures).toEqual([]);
  expect(verdict.lines.at(-1)).toBe(
    "keeps Table, Ledger out of the dynamic tier: no instance becomes a dynamic value",
  );
});

test("a build that is not asked prints no report", () => {
  const { status, stderr } = build(HANDED_OVER, null);
  expect(status, stderr).toBe(0);
  expect(stderr).not.toContain("scriptc dynamic-class");
  expect(dynamicClassReport(stderr)).toBeNull();
});
