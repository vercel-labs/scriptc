/* SCRIPTC_LOWERING_FACTS_VERIFY=1 makes one island round's shared program
 * facts answer twice: every hit on a fact is recomputed from scratch and the
 * two answers compared, and a mismatch throws instead of picking one. The
 * mode's whole-corpus run is only evidence if the mode actually engages
 * there, and a silent run is otherwise indistinguishable from a run that
 * checked nothing — so this test compiles a real program with the mode on and
 * requires the hit counter to move.
 *
 * The mode is read when lowering-facts.ts loads, so the environment is set
 * before the compiler is imported (the dynamic imports below). The frontend
 * runs in this process (`outputKind: "ir"` stops before codegen), which is
 * also the process the counter lives in.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";

const fixtureDir = join(
  import.meta.dirname,
  "../../node_modules/.cache/scriptc-tests/lowering-facts-verify",
);
const entryPath = join(fixtureDir, "main.ts");

// The facts each pass of one island round shares: protocol identity for a
// class and for an object literal whose member kinds disagree with its
// target, stdlib provenance of a Map, and the per-file classification every
// fact memo is keyed by. A declaration nothing reads whose type has no
// static mapping is looked for in every file by name, and each reference to
// the default import resolves its module.
const program = `import tally from "./tally.ts";
var spare: typeof Array;
interface Reader {
  read(): string;
}
interface Sized {
  readonly size: number;
}
class Parts implements Reader, Sized {
  private readonly items: string[] = ["a", "b"];
  read(): string {
    return this.items.join("-");
  }
  get size(): number {
    return this.items.length;
  }
}
interface Report {
  title: string;
  words: number;
}
function report(): Report {
  return {
    title: "monthly",
    get words(): number {
      return "two words".split(" ").length;
    },
  };
}
const parts = new Parts();
const totals = new Map<string, number>([["a", 1]]);
const literal = report();
console.log(parts.read(), parts.size, literal.words, totals.get("a"));
console.log(tally(["a", "b"]), tally([]));
`;
const tallyModule = `export default function tally(words: string[]): number {
  let length = 0;
  for (const word of words) length += word.length;
  return length;
}
`;

const previousVerify = process.env["SCRIPTC_LOWERING_FACTS_VERIFY"];
const previousFrontendProcess = process.env["SCRIPTC_FRONTEND_PROCESS"];
process.env["SCRIPTC_LOWERING_FACTS_VERIFY"] = "1";
process.env["SCRIPTC_FRONTEND_PROCESS"] = "0";
const { compile } = await import("@scriptc/compiler");
const { verifiedLoweringFactHits } =
  await import("../../packages/compiler/src/frontend/lowering/lowering-facts.js");
if (previousVerify === undefined) delete process.env["SCRIPTC_LOWERING_FACTS_VERIFY"];
else process.env["SCRIPTC_LOWERING_FACTS_VERIFY"] = previousVerify;
if (previousFrontendProcess === undefined) delete process.env["SCRIPTC_FRONTEND_PROCESS"];
else process.env["SCRIPTC_FRONTEND_PROCESS"] = previousFrontendProcess;

test("the verify mode recomputes a real compile's shared facts", async () => {
  mkdirSync(fixtureDir, { recursive: true });
  writeFileSync(entryPath, program);
  writeFileSync(join(fixtureDir, "tally.ts"), tallyModule);
  const before = verifiedLoweringFactHits();
  const beforeSpelled = verifiedLoweringFactHits("maySpellIdentifier");
  const beforeImported = verifiedLoweringFactHits("importedModule");
  const beforeProvenance = verifiedLoweringFactHits("symbolProvenance");
  const beforeProtocols = verifiedLoweringFactHits("classProtocols");
  const result = await compile(entryPath, {
    outPath: join(fixtureDir, "main.ir"),
    outDir: fixtureDir,
    outputKind: "ir",
  });
  if (!result.ok)
    throw new Error(
      "fixture failed to compile:\n" +
        result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"),
    );
  // Every pass of the round asks the same program facts: file paths,
  // classification, provenance, protocol identity. A compile that lowered
  // answers hundreds of them, so a small nonzero count would mean the mode
  // reached only part of the passes.
  expect(verifiedLoweringFactHits() - before).toBeGreaterThan(100);
  // The Lowerer's own per-pass comparisons record here too (its provenance
  // hits and its fresh class-protocol index), so a mode that only counted
  // LoweringFacts' internal hits cannot satisfy this.
  expect(verifiedLoweringFactHits("symbolProvenance") - beforeProvenance).toBeGreaterThan(0);
  expect(verifiedLoweringFactHits("classProtocols") - beforeProtocols).toBeGreaterThan(0);
  // The search for the unread declaration skipped the module that does not
  // spell its name, and the default import's module was asked for again.
  expect(verifiedLoweringFactHits("maySpellIdentifier") - beforeSpelled).toBeGreaterThan(0);
  expect(verifiedLoweringFactHits("importedModule") - beforeImported).toBeGreaterThan(0);
});
