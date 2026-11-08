/* Holds the registry of whole-program facts (program-facts.ts) to the
 * source: a registered location that no longer exists, a fact derived from
 * text, or a whole-program scan nobody registered fails here. */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { Lowerer } from "./frontend/lowering/lowerer.js";
import { PROGRAM_FACTS, PROGRAM_SCANS, programFactLowererFields } from "./program-facts.js";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const sourceRoot = join(repoRoot, "packages/compiler/src");

/** The facts that were derived from text or a spelling when the registry
 * was written. Each has a change that removes it. No other name is accepted,
 * so nothing new can join them. */
const ONCE_TEXT_DERIVED: ReadonlySet<string> = new Set([
  "names-array-buffer-view",
  "names-temporal",
  "thenables-may-be-defined",
  "typeof-tested-name",
]);

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sourceFiles(path, out);
    else if (
      name.endsWith(".ts") &&
      !name.endsWith(".test.ts") &&
      !name.endsWith(".d.ts") &&
      !name.includes(".generated.") &&
      name !== "program-facts.ts"
    )
      out.push(path);
  }
  return out;
}

/** A declaration that starts in the first column: the formatter puts every
 * top-level declaration there, and nothing nested. */
const TOP_LEVEL =
  /^(?:export )?(?:default )?(?:declare )?(?:abstract )?(?:async )?(?:function\*?|const|let|var|class|interface|type|enum|namespace) ([A-Za-z_$][\w$]*)/;
/** An iteration of the program's source files. */
const FILE_SCAN = /\.(?:getSourceFiles|getImplementationSourceFiles)\(\)/;
/** A test of a source file's raw text, by the names the compiler gives a
 * source file, or through the helpers that report such a test to the build
 * cache (sourceTextIncludes, sourceTextMatches; their own definitions are
 * not tests). */
const TEXT_TEST =
  /\b(?:sf|file|source|sourceFile|src|f)\.text\.(?:includes|indexOf|search|match|startsWith)\(|\.test\((?:sf|file|source|sourceFile|src|f)\.text\)|(?<!function )\bsourceText(?:Includes|Matches)\(/;

/** Every whole-program scan in the compiler's source, counted by the
 * top-level declaration that holds it. */
function scanCensus(): Map<string, number> {
  const census = new Map<string, number>();
  for (const file of sourceFiles(sourceRoot)) {
    let declaration = "(module)";
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const top = TOP_LEVEL.exec(line);
      if (top) declaration = top[1]!;
      const code = line.trimStart();
      if (code.startsWith("//") || code.startsWith("*") || code.startsWith("/*")) continue;
      if (!FILE_SCAN.test(line) && !TEXT_TEST.test(line)) continue;
      const site = `${relative(sourceRoot, file).split("\\").join("/")}#${declaration}`;
      census.set(site, (census.get(site) ?? 0) + 1);
    }
  }
  return census;
}

test("every fact names a place that exists", () => {
  const names = PROGRAM_FACTS.map((fact) => fact.name);
  expect(new Set(names).size).toBe(names.length);
  const missing: string[] = [];
  for (const fact of PROGRAM_FACTS) {
    for (const field of [fact.setBy, fact.gates, fact.narrower])
      expect(field.length, fact.name).toBeGreaterThan(0);
    const path = join(repoRoot, fact.file);
    const symbol = new RegExp(`(^|[^\\w$])${fact.symbol.replace(/\$/g, "\\$")}(?![\\w$])`);
    if (!existsSync(path) || !symbol.test(readFileSync(path, "utf8")))
      missing.push(`${fact.name}: ${fact.symbol} in ${fact.file}`);
  }
  expect(missing).toEqual([]);
});

test("no fact is derived from source text or a spelling", () => {
  // A comment, a string or an unrelated identifier must not change how the
  // rest of a program compiles. Decide the fact from the syntax tree, the
  // symbols or the types of the value or site it concerns.
  const derived = PROGRAM_FACTS.filter(
    (fact) => fact.source === "text" || fact.source === "spelling",
  ).map((fact) => fact.name);
  expect(derived.filter((name) => !ONCE_TEXT_DERIVED.has(name))).toEqual([]);
});

test("every whole-program scan is registered", () => {
  const census = scanCensus();
  const registered = new Map(PROGRAM_SCANS.map((row) => [row.site, row.count]));
  expect(registered.size).toBe(PROGRAM_SCANS.length);
  // A scan that is not registered: a declaration iterates the program's
  // source files, or tests a file's raw text, and program-facts.ts does not
  // say what it decides. Add a PROGRAM_SCANS row; if one occurrence it finds
  // changes how unrelated code compiles, add the PROGRAM_FACTS entry too.
  const unregistered = [...census]
    .filter(([site, count]) => registered.get(site) !== count)
    .map(
      ([site, count]) => `${site}: ${count} in the source, ${registered.get(site) ?? 0} registered`,
    );
  expect(unregistered).toEqual([]);
  const stale = [...registered.keys()].filter((site) => !census.has(site));
  expect(stale).toEqual([]);
});

test("every scan row says what it decides", () => {
  const facts = new Set(PROGRAM_FACTS.map((fact) => fact.name));
  const wrong: string[] = [];
  for (const row of PROGRAM_SCANS) {
    if (row.kind === "fact" ? row.fact === null || !facts.has(row.fact) : row.fact !== null)
      wrong.push(`${row.site}: fact ${String(row.fact)}`);
    if (row.kind !== "fact" && row.why.length === 0) wrong.push(`${row.site}: no reason`);
  }
  expect(wrong).toEqual([]);
});

test("every cached fact is left out of the unit journal by name", () => {
  const unjournaled = new Set(Lowerer.unjournaled);
  expect(programFactLowererFields().filter((field) => !unjournaled.has(field))).toEqual([]);
});
