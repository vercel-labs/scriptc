import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

/** Compiles `source` to IR. `island` is the JavaScript of a package named
 * `held` that the program can import and that the build runs in a Node
 * island: it keeps one value and hands it back. */
async function compileSource(source: string, island = false) {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-crash-refusals-"));
  try {
    const entry = join(directory, "main.ts");
    writeFileSync(entry, source);
    if (island) {
      const pkg = join(directory, "node_modules/held");
      mkdirSync(pkg, { recursive: true });
      writeFileSync(
        join(pkg, "package.json"),
        `{ "name": "held", "version": "1.0.0", "main": "index.js", "types": "index.d.ts" }\n`,
      );
      writeFileSync(
        join(pkg, "index.js"),
        `"use strict";\nlet kept;\nexports.keep = (v) => (kept = v);\nexports.kept = () => kept;\n`,
      );
      writeFileSync(
        join(pkg, "index.d.ts"),
        `export declare function keep(v: Generator<number>): Generator<number>;\nexport declare function kept(): Generator<number>;\n`,
      );
    }
    return await compile(entry, {
      outDir: directory,
      outPath: join(directory, "program.ir"),
      outputKind: "ir",
      ...(island ? { nodeIslands: { islands: ["held"] } } : {}),
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** The program is refused, every diagnostic has a code other than the
 * internal compiler error's, and one of them has `code` and mentions `text`. */
async function expectRefusal(
  source: string,
  code: string,
  text: string,
  island = false,
): Promise<void> {
  const result = await compileSource(source, island);
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
// initializer can hold undefined: no union with a dynamic arm is built, and
// the assertion back to a type argument that is undefined is the checked
// cast to undefined.
test("an undefined value through unknown inside a generic compiles", async () => {
  const result = await compileSource(
    `function throughUnknown<T>(value: T): T {
  const held: unknown = value;
  return held as T;
}
const result: unknown = throughUnknown(undefined);
console.log(result ? "t" : "f");
`,
  );
  expect(result.ok ? [] : result.diagnostics.map((d) => `${d.code}: ${d.message}`)).toEqual([]);
});

const GENERATORS = `function* count(from: number): Generator<number> {
  yield from;
  yield from + 1;
}
const first = count(1);
`;

// A generator has no array storage: the array is a checked-dynamic value,
// and the program compiles.
test("an array of generators compiles in a program without a Node island", async () => {
  const result = await compileSource(
    `${GENERATORS}const list = [first];
const head = list[0]!;
console.log(head === first, list.indexOf(first));
`,
  );
  expect(result.ok, JSON.stringify(result.ok ? [] : result.diagnostics)).toBe(true);
});

// A generator that crosses into a Node island is not the same value on the
// other side yet, so a program that runs an island keeps the array refused:
// by name where the backend used to stop with an internal error.
test("an array of generators in a program that runs a Node island is refused by name", async () => {
  const result = await compileSource(
    `import { keep } from "held";
${GENERATORS}const list = [first];
const back = keep(first);
console.log(list.length, back.next().value);
`,
    true,
  );
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.diagnostics.map((d) => d.code)).toEqual(["SC8010"]);
  expect(result.diagnostics[0]!.message).toContain("an array that holds generators");
  expect(result.diagnostics[0]!.loc.end).toBeGreaterThan(0);
});

// A use the lowering refuses by name is the program's one diagnostic, as it
// was before such arrays compiled anywhere.
test("an element of an array of generators handed to a Node island keeps its refusal", async () => {
  const result = await compileSource(
    `import { keep, kept } from "held";
const made = kept();
const list = [made];
console.log(keep(list[0]).next().done);
`,
    true,
  );
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.diagnostics.map((d) => d.code)).toEqual(["SC8010"]);
  expect(result.diagnostics[0]!.message).toContain("has no island export");
});
