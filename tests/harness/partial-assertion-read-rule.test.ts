import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const execFileAsync = promisify(execFile);

// An object literal asserted to a record type it does not complete
// (`{} as T`) is completed by the writes that follow. Reading a required
// property that nothing wrote throws a catchable TypeError that names the
// property and the asserted type, where Node answers undefined: a
// documented divergence, so it is pinned here and not in the differential
// corpus. The rule is the same for every way of reading the property: a
// member read, a computed key, the read of `??=`, `||=` and `+=`, and a
// spread, which reads every property. None of them stops the process.
test("every read of a property a partial assertion left unwritten throws the same TypeError", async () => {
  const outDir = mkdtempSync(join(tmpdir(), "scriptc-partial-read-rule-"));
  const entry = join(outDir, "main.ts");
  writeFileSync(
    entry,
    `
type Key = "alpha" | "beta";
type Row = Record<Key, number>;
type Groups = Record<Key, number[]>;
function attempt(label: string, run: () => unknown): void {
  try {
    console.log(label, run());
  } catch (error) {
    console.log(label, error instanceof TypeError, (error as Error).message);
  }
}
const key = (name: string): Key => name as Key;
const row = {} as Row;
row.beta = 2;
attempt("member", () => row.alpha);
attempt("computed", () => row[key("alpha")]);
attempt("computed, written", () => row[key("beta")]);
attempt("nullish assignment", () => (row[key("alpha")] ??= 5));
attempt("compound assignment", () => (row[key("alpha")] += 1));
attempt("spread", () => JSON.stringify({ ...row }));
const groups = {} as Groups;
attempt("grouping", () => (groups[key("alpha")] ||= []).push(1));
attempt("keys", () => Object.keys(row).join(","));
row.alpha = 1;
attempt("complete, computed", () => row[key("alpha")] + row[key("beta")]);
attempt("complete, spread", () => JSON.stringify({ ...row }));
attempt("complete, compound", () => (row[key("alpha")] += 1));
export {};
`,
  );
  const result = await compile(entry, {
    backend: "llvm",
    sanitize: process.env["SCRIPTC_SAN"] === "1",
    outDir,
    outPath: join(outDir, "program"),
  });
  expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true);
  if (!result.ok) return;
  const { stdout, stderr } = await execFileAsync(result.binaryPath, [], { encoding: "utf8" });
  const unwritten = (property: string, type: string): string =>
    `true Cannot read property '${property}': the object asserted as '${type}' has no such property`;
  expect(stdout).toBe(
    [
      `member ${unwritten("alpha", "Row")}`,
      `computed ${unwritten("alpha", "Row")}`,
      "computed, written 2",
      `nullish assignment ${unwritten("alpha", "Row")}`,
      `compound assignment ${unwritten("alpha", "Row")}`,
      `spread ${unwritten("alpha", "Row")}`,
      `grouping ${unwritten("alpha", "Groups")}`,
      "keys beta",
      "complete, computed 3",
      'complete, spread {"beta":2,"alpha":1}',
      "complete, compound 2",
      "",
    ].join("\n"),
  );
  expect(stderr).toBe("");
});
