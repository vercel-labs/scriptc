import { expect, test } from "vitest";
import { VOID, type IrModule } from "../../ir/ir.js";
import { LlEmitter } from "./emitter.js";

const loc = { file: "large-metadata.ts", start: 0, end: 0 };

/** A program whose entry does nothing. */
function emptyModule(): IrModule {
  return {
    irVersion: 17,
    sourceFile: loc.file,
    entry: "main",
    functions: [{ name: "main", params: [], returnType: VOID, locals: [], body: [], loc }],
  };
}

test("a field-alias metadata table larger than the host's argument limit is emitted", () => {
  const emitter = new LlEmitter(emptyModule(), {});
  expectLargeFieldAliasTable(emitter);
});

test("the library module emits the same large field-alias table", () => {
  const emitter = new LlEmitter(
    {
      ...emptyModule(),
      lib: {
        profileName: "large-metadata",
        prefix: "sc_large",
        initSymbol: "sc_large_init",
        sinkRegisterSymbol: "sc_large_sink",
        collectSymbol: null,
        resultResetSymbol: null,
        threadInstances: false,
        exports: [],
        trapOverlays: [],
      },
    },
    {},
  );
  expectLargeFieldAliasTable(emitter);
});

/** Seeds the table the issue's reproduction builds (one tag per field
 * category, two metadata lines each) and checks every line is emitted in the
 * table's order. */
function expectLargeFieldAliasTable(emitter: LlEmitter): void {
  const tags = 100_000;
  for (let i = 0; i < tags; i++) emitter.fieldAliasTags.set(`field:f${i}`, 2 + i * 2);

  const lines = emitter.emitParts();
  expect(lines.join("\n").split('!0 = !{!"scriptc native fields"}').length - 1).toBe(1);
  const first = lines.findIndex((line) => line.includes('!"field:f0"'));
  const middle = lines.findIndex((line) => line.includes(`!"field:f${tags >> 1}"`));
  const last = lines.findIndex((line) => line.includes(`!"field:f${tags - 1}"`));
  expect(first).toBeGreaterThan(-1);
  expect(middle).toBeGreaterThan(first);
  expect(last).toBeGreaterThan(middle);
  expect(lines.filter((line) => line.startsWith("!"))).toHaveLength(1 + tags * 2);
}
