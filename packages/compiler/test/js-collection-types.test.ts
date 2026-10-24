import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule, validateModule } from "../src/index.js";

// Corpus 7985 exercises every refusal: only the collections whose uses
// prove their types lower as typed collections; the rest stay untyped.
test("untyped JavaScript collections take the types their uses prove, and only those", async () => {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-js-collection-types-"));
  try {
    const entry = join(
      import.meta.dirname,
      "../../../tests/corpus/7985-untyped-collection-types.mjs",
    );
    const output = join(dir, "main.ir.json");
    const lowered = await compile(entry, { outputKind: "ir", outDir: dir, outPath: output });
    if (!lowered.ok) throw new Error(JSON.stringify(lowered.diagnostics));
    const module = deserializeModule(readFileSync(output, "utf8"));
    expect(validateModule(module)).toEqual([]);
    const types = new Map(module.globals.map((g) => [g.name, JSON.stringify(g.type)]));
    const map = (key: string, value: string) =>
      JSON.stringify({ kind: "map", key: { kind: key }, value: { kind: value } });
    const set = (elem: string) => JSON.stringify({ kind: "set", elem: { kind: elem } });
    const array = (elem: string) => JSON.stringify({ kind: "array", elem: { kind: elem } });
    // Untyped collections hold checked-dynamic keys, values and elements.
    const typed = (t: string) => !t.includes('"dyn"');
    expect(Object.fromEntries([...types].filter(([, t]) => typed(t)))).toEqual({
      counts: map("string", "f64"),
      seen: set("f64"),
      stack: array("f64"),
      words: array("string"),
      byNumber: map("f64", "string"),
      nums: array("f64"),
      flags: set("bool"),
      cache: map("string", "f64"),
      "%loaded": '{"kind":"bool"}',
    });
    for (const untyped of [
      "strings",
      "numbers",
      "mixedKeys",
      "mixedValues",
      "mixedElements",
      "passed",
      "stored",
      "iterated",
      "eachSet",
      "shown",
      "chained",
      "optional",
      "indexed",
      "truncated",
      "spread",
      "unread",
      "exported",
    ])
      expect(typed(types.get(untyped)!), untyped).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
