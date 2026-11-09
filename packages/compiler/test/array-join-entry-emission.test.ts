/* `join` has two runtime entries: scr_arr_join_str for a receiver whose
 * element type is `string` (an optional runtime unit, linked by the
 * arrJoinStr feature) and scr_arr_join for numbers and booleans. The choice
 * reads the receiver's static type, so every route by which a `string[]`
 * reaches the call takes the typed entry, and a program that joins no string
 * array names nothing of that unit. */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { compile } from "../src/index.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function emit(source: string): Promise<string> {
  const outDir = await mkdtemp(join(tmpdir(), "scriptc-join-entry-"));
  directories.push(outDir);
  const entry = join(outDir, "main.ts");
  await writeFile(entry, source);
  const outPath = join(outDir, "program.ll");
  const result = await compile(entry, { entry, outDir, outPath, outputKind: "llvm" });
  expect(result.ok, JSON.stringify(result)).toBe(true);
  return readFile(outPath, "utf8");
}

const TYPED = /call ptr @scr_arr_join_str\(/;
const GENERAL = /call ptr @scr_arr_join\(/;

const stringRoutes: [string, string][] = [
  ["a local", `const parts = ["a", "b"];\nparts.push(process.argv[0] ?? "");\nconsole.log(parts.join("-"));\n`],
  [
    "a field",
    `class Holder {\n  parts: string[] = [];\n  text(): string {\n    return this.parts.join("-");\n  }\n}\nconst h = new Holder();\nh.parts.push(process.argv[0] ?? "");\nconsole.log(h.text());\n`,
  ],
  [
    "a parameter",
    `function text(parts: string[], sep: string): string {\n  return parts.join(sep);\n}\nconsole.log(text(process.argv, "-"));\n`,
  ],
  [
    "a readonly array",
    `function text(parts: readonly string[], more: ReadonlyArray<string>): string {\n  return parts.join("-") + more.join("+");\n}\nconsole.log(text(process.argv, process.argv));\n`,
  ],
  ["a call result", `console.log(process.argv.map((s) => s + s).join("-"));\n`],
  ["a split", `console.log((process.argv[0] ?? "").split("/").join("-"));\n`],
  [
    "a checked conversion from unknown",
    `function text(value: unknown): string {\n  return (value as string[]).join("-");\n}\nconsole.log(text(process.argv));\n`,
  ],
  [
    "elements of a literal union",
    `const kinds: Array<"x" | "y"> = [];\nkinds.push(process.argv.length > 9 ? "x" : "y");\nconsole.log(kinds.join("-"));\n`,
  ],
  ["the default separator", `console.log(process.argv.join());\n`],
  // An element that may be undefined is a string slot with a state, not a
  // union arm: the array is a string array.
  [
    "elements that may be undefined",
    `const u: Array<string | undefined> = [];\nu.push(process.argv[5]);\nconsole.log(u.join("-"));\n`,
  ],
  [
    "an array that holds holes",
    `const parts = new Array<string>(3);\nparts[1] = process.argv[0] ?? "";\nconsole.log(parts.join("-"));\n`,
  ],
];

test.each(stringRoutes)("a string array reaching join through %s takes the typed entry", async (_route, source) => {
  const llvm = await emit(source);
  expect(llvm).toMatch(TYPED);
  expect(llvm).not.toMatch(GENERAL);
});

const otherReceivers: [string, string, boolean][] = [
  ["numbers", `const n: number[] = [];\nn.push(process.argv.length);\nconsole.log(n.join("-"));\n`, true],
  ["booleans", `const b: boolean[] = [];\nb.push(process.argv.length > 2);\nconsole.log(b.join("-"));\n`, true],
  [
    "strings or null",
    `const u: Array<string | null> = [];\nu.push(process.argv.length > 9 ? null : "s");\nconsole.log(u.join("-"));\n`,
    false,
  ],
  [
    "untyped values",
    `const v: unknown[] = [];\nv.push(process.argv[0]);\nconsole.log(v.join("-"));\n`,
    false,
  ],
  [
    "an array asked through Array.isArray",
    `function text(value: unknown): string {\n  return Array.isArray(value) ? value.join("-") : "";\n}\nconsole.log(text(process.argv));\n`,
    false,
  ],
  [
    "a tuple of strings",
    `const pair: [string, string] = [process.argv[0] ?? "", "q"];\nconsole.log(pair.join("-"));\n`,
    false,
  ],
];

test.each(otherReceivers)("a join of %s names nothing of the typed entry", async (_kind, source, general) => {
  const llvm = await emit(source);
  expect(llvm).not.toContain("scr_arr_join_str");
  if (general) expect(llvm).toMatch(GENERAL);
  else expect(llvm).not.toMatch(GENERAL);
});

test("a program that joins nothing names neither entry", async () => {
  const llvm = await emit(`console.log(process.argv.length);\n`);
  expect(llvm).not.toContain("scr_arr_join");
});
