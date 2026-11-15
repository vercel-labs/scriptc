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

test("a source file keeps its partition group number when a file is added", () => {
  const before = groupLines(["a.ts", "b.ts"], "main.ts");
  const after = groupLines(["a.ts", "b.ts", "c.ts"], "main.ts");
  expect(after.length).toBe(before.length + 1);
  expect(after.slice(0, before.length)).toEqual(before);
});

test("a source file's partition group number is its place in function order", () => {
  // The helper hashes a group's key to choose its partitions, so the number
  // is the placement itself, not a label: it follows the module's function
  // order. Hashing the file name here (#2950) moved whole files to other
  // partitions and cost tsc-ts about 1.5% on trpc c1.
  expect(groupLines(["b.ts", "a.ts"], "main.ts")).toEqual([
    "; scriptc-group 0",
    "; scriptc-group 1",
    "; scriptc-group 2",
  ]);
});

test("a source file's partition group number does not depend on the program's directory", () => {
  expect(groupLines(["/home/one/src/a.ts"], "/home/one/src/main.ts")).toEqual(
    groupLines(["/home/two/build/src/a.ts"], "/home/two/build/src/main.ts"),
  );
});

/** The group lines a module emits for `files`, with `sourceFile` as its
 * entry. */
function groupLines(files: string[], sourceFile: string): string[] {
  const module: IrModule = { ...emptyModule(), sourceFile };
  const main = module.functions[0];
  if (main !== undefined) main.loc = { file: sourceFile, start: 0, end: 0 };
  files.forEach((file, index) =>
    module.functions.push({
      name: `helper${index}`,
      params: [],
      returnType: VOID,
      locals: [],
      body: [],
      loc: { file, start: 0, end: 0 },
    }),
  );
  return new LlEmitter(module, {})
    .emitParts()
    .join("\n")
    .split("\n")
    .filter((line) => /^; scriptc-group \d+$/.test(line));
}

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
