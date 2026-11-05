// `.filter` on a union of arrays (`A[] | B[]`): the predicate runs over
// `A | B`, and the checker's result element is the arm the predicate names.
// The runtime value is one concrete arm's array, so the lowering must
// dispatch on that arm (unionIsTag), filter the arm's own array, and convert
// the survivors to the named element through the checked narrowing — never
// hand a union receiver to a static array intrinsic.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule, validateModule } from "../src/index.js";

const PRELUDE = [
  "interface TextContent { type: 'text'; text: string }",
  "interface ImageContent { type: 'image'; data: string }",
  "interface ThinkingContent { type: 'thinking'; thinking: string }",
  "type MessageContent =",
  "  | TextContent[]",
  "  | (ImageContent | TextContent)[]",
  "  | (ThinkingContent | TextContent)[];",
];

type IrModule = {
  entry: string;
  functions: { name: string; body: unknown }[];
};

async function compileToIr(
  body: string[],
): Promise<{ ok: boolean; module: IrModule | null; diagnostics: string }> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-union-array-filter-"));
  try {
    const entry = join(dir, "main.ts");
    const outPath = join(dir, "main.ir.json");
    await writeFile(entry, [...PRELUDE, ...body].join("\n"));
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "ir" });
    if (!result.ok)
      return {
        ok: false,
        module: null,
        diagnostics: result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"),
      };
    const module = deserializeModule(await readFile(outPath, "utf8")) as unknown as IrModule;
    expect(validateModule(module as never)).toEqual([]);
    return { ok: true, module, diagnostics: "" };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function named(module: IrModule, part: string): string {
  return JSON.stringify(module.functions.filter((fn) => fn.name.includes(part)));
}

test("filter on a union of arrays dispatches on the arm", async () => {
  const compiled = await compileToIr([
    "function texts(content: MessageContent): string {",
    "  return content",
    "    .filter((block): block is TextContent => block.type === 'text')",
    "    .map((block) => block.text)",
    "    .join(' ');",
    "}",
    "const blocks: MessageContent = [{ type: 'text', text: 'a' }];",
    "console.log(texts(blocks));",
  ]);
  expect(compiled.diagnostics).toBe("");
  expect(compiled.ok).toBe(true);
  const module = compiled.module!;
  // The tag dispatch that reads the runtime arm…
  const union = named(module, "%arr.union");
  expect(union).toContain("unionIsTag");
  // …and the checked narrowing each arm's survivors pass through, so a
  // predicate that kept an element it does not describe throws.
  expect(named(module, "%arr.narrow")).toContain("%narrow.checked");
});

test("filter on a union of arrays keeps the fence without a narrowing", async () => {
  // A predicate that names no narrower element answers the union-wide
  // element; converting an arm's array to that element is a widening this
  // lowering does not build, so the call stays a refusal instead of
  // compiling to a different array layout.
  const compiled = await compileToIr([
    "function counts(content: MessageContent): number {",
    "  return content.filter((block): boolean => block.type !== 'image').length;",
    "}",
    "console.log(counts([]));",
  ]);
  expect(compiled.ok).toBe(false);
  expect(compiled.diagnostics).toContain("SC2020");
});
