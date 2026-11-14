import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const execFileAsync = promisify(execFile);

// A class that extends Array types its instances as arrays, so a plain
// array parsed from JSON into a parameter typed as an array of instances
// reaches the class's members. Its fields live after an instance's array
// header, which a plain array does not have: reading or writing one, or an
// accessor that does, throws a catchable TypeError naming the member (Node
// reads a missing property of the plain array, which the field's type
// cannot hold). Instances in the same array keep their fields.
test("an Array subclass's fields on a plain array throw a TypeError", async () => {
  const outDir = mkdtempSync(join(tmpdir(), "scriptc-array-subclass-fields-"));
  const entry = join(outDir, "main.ts");
  writeFileSync(
    entry,
    `
class Tally extends Array<number> {
  bonus = 10;
  label = "tally";
  get doubled(): number { return this.bonus * 2; }
  set doubled(value: number) { this.bonus = value / 2; }
}
function attempt(run: () => unknown): void {
  try { console.log(run()); } catch (error) { console.log((error as Error).name, (error as Error).message); }
}
function visit(rows: Tally[]): void {
  for (const row of rows) {
    attempt(() => row.bonus);
    attempt(() => row.label.length);
    attempt(() => { row.bonus = 3; return row.bonus; });
    attempt(() => { row.bonus += 1; return row.bonus; });
    attempt(() => row.doubled);
    attempt(() => { row.doubled = 8; return row.bonus; });
  }
}
const real = new Tally();
real.push(1);
const parsed: Tally[] = JSON.parse("[[1, 2], []]");
visit([real, ...parsed]);
console.log(parsed.map((row) => row.length).join(","));
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
  const refused = (action: string, member: string): string =>
    `TypeError Cannot ${action} '${member}' of an array that is not a Tally instance`;
  const plain = [
    refused("read", "bonus"),
    refused("read", "label"),
    refused("set", "bonus"),
    refused("read", "bonus"),
    refused("read", "doubled"),
    refused("set", "doubled"),
  ];
  expect(stdout).toBe(["10", "5", "3", "4", "8", "4", ...plain, ...plain, "2,0", ""].join("\n"));
  expect(stderr).toBe("");
});
