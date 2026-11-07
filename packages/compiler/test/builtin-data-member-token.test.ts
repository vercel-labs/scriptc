/* In a JavaScript source, an unsupported builtin value read as an identifier
 * becomes an identity token: a string no program text produces, so `===` and
 * Set membership agree between spellings. A member that holds data is not an
 * identity. A token in its place was read as the data: `title.length` was
 * the token's length, and array operations on a `string[]` member failed IR
 * validation (SC9001). Such a read is refused by name; the process members
 * that have a lowering read their value. */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { analyze } from "../src/index.js";

let directory: string;
beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), "scriptc-data-member-token-"));
});
afterAll(() => {
  rmSync(directory, { recursive: true, force: true });
});

function report(name: string, source: string): string[] {
  const entry = join(directory, name);
  writeFileSync(entry, source);
  const { coverage } = analyze(entry, {});
  return [...coverage.diagnostics, ...(coverage.runtimeFences ?? [])].map(
    (d) => `${d.code}: ${d.message}`,
  );
}

test("a string member with no lowering is refused by name where it is read", () => {
  const found = report(
    "data.mjs",
    `import { title } from "node:process";
console.log(title.length);
`,
  );
  expect(found).toHaveLength(1);
  expect(found[0]).toContain("SC2020");
  expect(found[0]).toContain("'process.title'");
});

test("an array member read by length and index is its value, not a token", () => {
  expect(
    report(
      "array.mjs",
      `import { execArgv } from "node:process";
for (let index = 0; index < execArgv.length; index += 1) console.log(execArgv[index]);
`,
    ),
  ).toEqual([]);
});

test("a class with no lowering keeps its identity token", () => {
  expect(
    report(
      "identity.mjs",
      `import { AsyncResource } from "node:async_hooks";
const known = new Set([AsyncResource]);
console.log(known.has(AsyncResource));
`,
    ),
  ).toEqual([]);
});
