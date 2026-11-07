import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

async function compileSource(source: string) {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-crash-refusals-"));
  try {
    const entry = join(directory, "main.ts");
    writeFileSync(entry, source);
    return await compile(entry, {
      outDir: directory,
      outPath: join(directory, "program.ir"),
      outputKind: "ir",
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** The program is refused, every diagnostic has a code other than the
 * internal compiler error's, and one of them has `code` and mentions `text`. */
async function expectRefusal(source: string, code: string, text: string): Promise<void> {
  const result = await compileSource(source);
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.diagnostics.map((d) => d.code)).not.toContain("SC9001");
  expect(result.diagnostics).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ code, message: expect.stringContaining(text) }),
    ]),
  );
  for (const diagnostic of result.diagnostics) expect(diagnostic.loc.end).toBeGreaterThan(0);
}

// The canonical mapping a failed slot retries with applies the array storage
// contract, so an array of handles is refused where it is written.
test("an array of file watchers is refused by name", async () => {
  await expectRefusal(
    `import * as fs from "node:fs";
const watcher = fs.watch(".");
const held: fs.FSWatcher[] = [watcher];
held[0]!.close();
console.log(held.length);
`,
    "SC1101",
    "converting typed values to 'unknown'",
  );
});

test("a generic array of file watchers is refused by name", async () => {
  await expectRefusal(
    `import * as fs from "node:fs";
function viaArray<T>(value: T): T {
  const held: T[] = [value];
  return held[0] as T;
}
const watcher = viaArray(fs.watch("."));
watcher.close();
`,
    "SC2009",
    "elements have no array representation yet",
  );
});

// A binding declared \`unknown\` keeps the checked dynamic when its
// initializer can hold undefined: no union with a dynamic arm is built.
test("an undefined value through unknown inside a generic is refused by name", async () => {
  await expectRefusal(
    `function throughUnknown<T>(value: T): T {
  const held: unknown = value;
  return held as T;
}
const result: unknown = throughUnknown(undefined);
console.log(result ? "t" : "f");
`,
    "SC1090",
    "a checked cast of 'unknown' to 'void'",
  );
});
