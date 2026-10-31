/* The three-argument writeFileSync forms whose options record is a `const`
 * binding. The lowering inlines the record's literal values at the write
 * site, so it accepts the binding only when the record is readonly: Node
 * reads the record when the call runs, and a mutable record may have
 * changed since its initializer (`OPTS.mode = 0o644` must reach the
 * write). */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

async function compileSource(source: string) {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-fs-write-options-"));
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

test.each([
  ["as const", 'const OPTS = { encoding: "utf-8", mode: 0o600 } as const;'],
  [
    "a Readonly<> annotation",
    'const OPTS: Readonly<{ encoding: "utf-8"; mode: number }> = { encoding: "utf-8", mode: 0o600 };',
  ],
])("a readonly const record (%s) keeps lowering", async (_what, declaration) => {
  const result = await compileSource(`import * as fs from "node:fs";
${declaration}
fs.writeFileSync("scratch.json", "{}", OPTS);
`);
  expect(result.ok, !result.ok ? JSON.stringify(result.diagnostics, null, 2) : "").toBe(true);
});

test("a MUTABLE const record fences: its mode may change before the call", async () => {
  const result = await compileSource(`import * as fs from "node:fs";
const OPTS: { encoding: "utf-8"; mode: number } = { encoding: "utf-8", mode: 0o600 };
OPTS.mode = 0o644;
fs.writeFileSync("scratch.json", "{}", OPTS);
`);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected the write options fence");
  expect(result.diagnostics).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        message: expect.stringContaining("writeFileSync with 3 arguments"),
      }),
    ]),
  );
  expect(result.diagnostics.some((diagnostic) => diagnostic.code === "SC9001")).toBe(false);
});
