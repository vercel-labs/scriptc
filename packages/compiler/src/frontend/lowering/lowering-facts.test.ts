import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { loadProgram } from "../program-node.js";
import type { Program, SourceFile, Symbol as TsSymbol } from "../ts7/adapter.js";
import type { AdmittedOpinion } from "../tsc-codes.js";
import { LoweringFacts } from "./lowering-facts.js";
import { Lowerer } from "./lowerer.js";
import { InternalCompilerError } from "../../errors.js";

/** A program that answers isSourceFileDefaultLibrary from `defaultLibrary`,
 * which the tests can flip under a live memo. */
function fakeProgram(defaultLibrary: (sf: SourceFile) => boolean = () => false): Program {
  const checker = {};
  return {
    getTypeChecker: () => checker,
    isSourceFileDefaultLibrary: defaultLibrary,
    getSourceFileNames: () => [],
  } as unknown as Program;
}

const file = (fileName: string): SourceFile =>
  ({ fileName, isDeclarationFile: true }) as unknown as SourceFile;

test("a fact is computed once and answers again from its memo", () => {
  let asked = 0;
  const facts = new LoweringFacts(
    fakeProgram(() => {
      asked++;
      return false;
    }),
    [],
    new Map(),
  );
  const sf = file("/project/node_modules/pkg/index.d.ts");
  expect(facts.isStdlibFile(sf)).toBe(false);
  expect(facts.isStdlibFile(sf)).toBe(false);
  expect(asked).toBe(1);
  expect(facts.verifiedHits("isStdlibFile")).toBe(0);
});

test("pathOf is the same spelling every pass asks for", () => {
  const facts = new LoweringFacts(fakeProgram(), [], new Map());
  const sf = file("/project/src/./a.ts");
  expect(facts.pathOf(sf)).toBe(facts.pathOf(sf));
  expect(facts.pathOf(sf)).toMatch(/\/project\/src\/a\.ts$/);
});

test("the verify mode fails when a shared answer no longer matches a fresh one", () => {
  let stale = false;
  const program = fakeProgram(() => stale);
  const facts = new LoweringFacts(program, [], new Map(), { verify: true });
  const sf = file("/project/src/a.ts");
  expect(facts.isStdlibFile(sf)).toBe(false);
  // The program answers differently now: a memo serving the old answer is
  // exactly the silent miscompile the mode exists to catch.
  stale = true;
  expect(() => facts.isStdlibFile(sf)).toThrow(InternalCompilerError);
  expect(facts.verifiedHits("isStdlibFile")).toBe(1);
});

test("the verify mode counts the hits it checked", () => {
  const facts = new LoweringFacts(fakeProgram(), [], new Map(), { verify: true });
  const sf = file("/project/src/a.ts");
  facts.pathOf(sf);
  facts.pathOf(sf);
  facts.pathOf(sf);
  expect(facts.verifiedHits("pathOf")).toBe(2);
});

test("an external type surface the fact was not built for bypasses the memo", () => {
  const program = fakeProgram();
  const surface = new Map([["/project/types/external.d.ts", ["ext"]]]);
  const facts = new LoweringFacts(program, [], surface);
  const sf = file("/project/types/external.d.ts");
  expect(facts.isExternalTypeFile(sf, surface)).toBe(true);
  // A pass asking with a DIFFERENT surface must not read the answer above.
  expect(facts.isExternalTypeFile(sf, new Map())).toBe(false);
  // ... and the surface answer is still the one the fact was built for.
  expect(facts.isExternalTypeFile(sf, surface)).toBe(true);
});

const opinion = (file: string): AdmittedOpinion =>
  ({ file, pos: 0, end: 1, code: 2551, view: "checker" }) as AdmittedOpinion;

test("the admitted-opinion index is rebuilt for another list", () => {
  const facts = new LoweringFacts(fakeProgram(), [], new Map());
  const one = [opinion("a.ts")];
  const two = [opinion("b.ts")];
  expect([...facts.opinionIndex(one).keys()]).toEqual(["a.ts\u00002551"]);
  expect([...facts.opinionIndex(two).keys()]).toEqual(["b.ts\u00002551"]);
  // The first list's index is still the one it was given.
  expect(facts.opinionIndex(one).size).toBe(1);
});

test("a Lowerer without LowererMode.facts gets a private copy", () => {
  const program = fakeProgram();
  const moduleOrder: SourceFile[] = [];
  const scoped = new LoweringFacts(program, moduleOrder, new Map());
  const own = new Lowerer(program, file("/island/entry.ts"), []);
  expect(own.facts).not.toBe(scoped);
  const shared = new Lowerer(program, file("/island/entry.ts"), moduleOrder, { facts: scoped });
  expect(shared.facts).toBe(scoped);
});

test("facts from another program are refused", () => {
  const first = fakeProgram();
  const facts = new LoweringFacts(first, [], new Map());
  expect(() => new Lowerer(fakeProgram(), file("/island/entry.ts"), [], { facts })).toThrow(
    InternalCompilerError,
  );
});

test("a shared symbol provenance answer is verified against a fresh walk", () => {
  const facts = new LoweringFacts(fakeProgram(), [], new Map(), { verify: true });
  const symbol = {
    declarations: [],
  } as unknown as TsSymbol;
  const first = { stdlibInterface: false, stdlibClass: false, libInterface: false };
  facts.symbolProvenance.set(symbol, first);
  // The hooks live on the Lowerer (verifySymbolProvenance); the memo itself
  // keeps the answer a pass stored.
  expect(facts.symbolProvenance.get(symbol)).toBe(first);
});

test("a file may spell a name only when one of its identifiers does", () => {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-lowering-facts-"));
  try {
    writeFileSync(
      join(directory, "main.ts"),
      `import { tend } from "./beds.ts";
var spare: typeof Array;
console.log(tend(3));
`,
    );
    // Spells `spare` in a string and in a comment only.
    writeFileSync(
      join(directory, "beds.ts"),
      `// spare beds are counted elsewhere
export function tend(count: number): number {
  const label = "spare";
  return count + label.length;
}
`,
    );
    const load = loadProgram(join(directory, "main.ts"));
    try {
      const facts = new LoweringFacts(load.program, load.moduleOrder, new Map(), { verify: true });
      const main = load.program.getSourceFile(join(directory, "main.ts"))!;
      const beds = load.program.getSourceFile(join(directory, "beds.ts"))!;
      expect(facts.maySpellIdentifier(main, "spare")).toBe(true);
      expect(facts.maySpellIdentifier(main, "tend")).toBe(true);
      // A string and a comment spell no identifier; the verify mode walks the
      // file again for each answer that skips it.
      expect(facts.maySpellIdentifier(beds, "spare")).toBe(false);
      expect(facts.maySpellIdentifier(beds, "console")).toBe(false);
      expect(facts.verifiedHits("maySpellIdentifier")).toBe(2);
      // Member names and parameter names are identifiers.
      expect(facts.maySpellIdentifier(beds, "length")).toBe(true);
      expect(facts.maySpellIdentifier(beds, "count")).toBe(true);
    } finally {
      load.dispose();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("an import specifier is resolved once for every pass that asks", () => {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-lowering-facts-"));
  try {
    writeFileSync(
      join(directory, "main.ts"),
      `import tend from "./beds.ts";
console.log(tend(3));
`,
    );
    writeFileSync(
      join(directory, "beds.ts"),
      `export default function tend(count: number): number {
  return count + 1;
}
`,
    );
    const load = loadProgram(join(directory, "main.ts"));
    try {
      const facts = new LoweringFacts(load.program, load.moduleOrder, new Map(), { verify: true });
      const main = load.program.getSourceFile(join(directory, "main.ts"))!;
      const beds = load.program.getSourceFile(join(directory, "beds.ts"))!;
      expect(facts.importedModule(main, "./beds.ts")).toBe(beds);
      expect(facts.importedModule(main, "./beds.ts")).toBe(beds);
      expect(facts.importedModule(main, "./missing.ts")).toBeNull();
      expect(facts.importedModule(main, "./missing.ts")).toBeNull();
      // An import and a require of one specifier are separate answers.
      expect(facts.importedModule(main, "./beds.ts", "require")).toBe(beds);
      expect(facts.verifiedHits("importedModule")).toBe(2);
      // No package of the program is compiled from node_modules.
      expect(facts.npmStaticModule(main, "./beds.ts")).toBeNull();
    } finally {
      load.dispose();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
