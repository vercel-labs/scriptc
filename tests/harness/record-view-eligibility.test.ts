/* Record-view eligibility: the frontend rewrites an observed record copy
 * into the checked conversion the backend can answer with a view. A source
 * the backend cannot view (a field that cannot be boxed as a live capsule:
 * a function, a class instance, fs.Stats; or a source that holds the target)
 * keeps its copy and its SC6001 warning instead of being rewritten into a
 * conversion that would silently copy, or fail with an internal error. */
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { analyze, compile } from "@scriptc/compiler";

const execFileAsync = promisify(execFile);
const outDir = join(
  import.meta.dirname,
  "../../node_modules/.cache/scriptc-tests/record-view-eligibility",
);
const sanitize = process.env["SCRIPTC_SAN"] === "1";

interface Result {
  readonly warnings: readonly { code: string; loc: { start: number } }[];
  readonly diagnostics: readonly { code: string }[];
  readonly stdout: string;
}

async function run(name: string, source: string): Promise<Result> {
  mkdirSync(outDir, { recursive: true });
  const dir = mkdtempSync(join(tmpdir(), `scriptc-view-eligibility-${name}-`));
  const file = join(dir, `${name}.ts`);
  writeFileSync(file, source);
  try {
    const analysis = analyze(file, {});
    const result = await compile(file, { outPath: join(outDir, name), outDir, sanitize });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    const runResult = await execFileAsync(join(outDir, name), [], { encoding: "utf8" });
    return {
      warnings: (analysis.coverage.divergences ?? []).map((d) => ({ code: d.code, loc: d.loc })),
      diagnostics: "diagnostics" in result ? (result.diagnostics ?? []) : [],
      stdout: runResult.stdout,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a source with a function field keeps the copy and its warning", async () => {
  const source = `interface WithHook { id: string; hook(): number }
interface Base { id: string }
const wide: WithHook = { id: "a", hook: () => 1 };
const narrow: Base = wide;
narrow.id = "b";
console.log(wide.id, narrow.id);
`;
  const result = await run("function-field", source);
  expect(result.warnings.filter((w) => w.code === "SC6001")).toHaveLength(1);
  expect(result.diagnostics).toEqual([]);
  expect(result.stdout).toBe("a b\n");
});

test("a source carrying fs.Stats keeps the copy and its warning", async () => {
  const source = `import { statSync, type Stats } from "node:fs";
interface Snapshot { stats: Stats; label: string; extra: number }
interface LabelOnly { label: string; extra: number }
const full: Snapshot = { stats: statSync("."), label: "root", extra: 1 };
const narrow: LabelOnly = full;
narrow.label = "changed";
console.log(full.label, narrow.label);
`;
  const result = await run("stats-field", source);
  expect(result.warnings.filter((w) => w.code === "SC9001")).toEqual([]);
  expect(result.warnings.filter((w) => w.code === "SC6001")).toHaveLength(1);
  expect(result.diagnostics).toEqual([]);
  expect(result.stdout).toBe("root changed\n");
});
