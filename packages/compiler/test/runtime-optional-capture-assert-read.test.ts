// A capture read through an erased assertion (`(x as T).field`) keeps the
// checker's flow proof at `x`, not the assertion's type: Node erases `as`
// and reads the value actually stored. With multi-arm storage the checked
// extraction takes the proved arm; without a proof the read stays refused.
// The array comes from another module, which is what makes its element read
// runtime-optional in the whole-program pre-pass.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule, validateModule } from "../src/index.js";

const RECORDS = [
  'export type Header = { type: "session"; id: string; version: number };',
  'export type Item = { type: "text"; id: string; text: string } | { type: "tool"; id: string; count: number };',
  "export type Entry = Header | Item;",
  "export function makeEntries(): Entry[] {",
  "\tconst entries: Entry[] = [];",
  '\tentries.push({ type: "session", id: "s", version: 1 });',
  "\treturn entries;",
  "}",
];

async function compileProgram(body: string[]): Promise<{ ok: boolean; diagnostics: string }> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-capture-assert-read-"));
  try {
    const entry = join(dir, "main.ts");
    const outPath = join(dir, "main.ir.json");
    await writeFile(join(dir, "records.ts"), RECORDS.join("\n"));
    await writeFile(
      entry,
      ['import { makeEntries, type Entry } from "./records.ts";', ...body].join("\n"),
    );
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "ir" });
    if (!result.ok)
      return {
        ok: false,
        diagnostics: result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"),
      };
    const module = deserializeModule(await readFile(outPath, "utf8"));
    expect(validateModule(module as never)).toEqual([]);
    return { ok: true, diagnostics: "" };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("an asserted read of a capture narrowed to one stored arm compiles", async () => {
  const compiled = await compileProgram([
    "function headerId(entries: Entry[]): string {",
    '  if (entries.length === 0) return "empty";',
    "  const header = entries[0];",
    '  if (header.type !== "session") return "other";',
    '  if (typeof (header as { id?: unknown }).id !== "string") return "no-id";',
    '  return "id";',
    "}",
    "console.log(headerId(makeEntries()));",
  ]);
  expect(compiled.ok, compiled.diagnostics).toBe(true);
});

test("an asserted read without a flow proof keeps the refusal", async () => {
  const compiled = await compileProgram([
    "function headerId(entries: Entry[]): string {",
    "  const header = entries[0];",
    '  if (typeof (header as { id?: unknown }).id !== "string") return "no-id";',
    '  return "id";',
    "}",
    "console.log(headerId(makeEntries()));",
  ]);
  expect(compiled.ok).toBe(false);
  expect(compiled.diagnostics).toContain("SC1090");
  expect(compiled.diagnostics).toContain(
    "a direct read from a runtime-optional capture with multiple value arms",
  );
});
