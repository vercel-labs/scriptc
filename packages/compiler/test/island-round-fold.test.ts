// A round that grew the island set also decides the fence growth from the
// same lowering pass (WP9, node-islands/growth.ts's foldFenceGrowth), so a
// build reloads once instead of twice. The fence rule reads what the reload
// still compiles: a package the new islands reach only through themselves
// leaves the compiled program with them, so its fences are not a decision
// that round can make (it is in the set by containment instead).
//
// This compiles one fixture through prepareExecutableModule with the fold on
// and off, and requires the merged round to island exactly what today's
// second reload does — one reload fewer, the same islands, both compiling.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import type { ScrDiagnostic } from "../src/diagnostics/diagnostic.js";
import { prepareExecutableModule } from "../src/executable/prepare.js";
import type { LowerResult } from "../src/frontend/lowering/lowerer.js";
import { runFrontend, type FrontendFactory } from "../src/frontend/pipeline.js";
import { loadProgram } from "../src/frontend/program-node.js";

const scratch: string[] = [];
afterEach(() => {
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true });
});

/** An ES-module-bundle prologue whose exports are defined at run time
 * (getters over live bindings) beside a constructor function with prototype
 * methods, with the annotation bundlers add so Node's lexer finds the
 * names. The package compiles natively, with pre-scan markers and no
 * refusal of its own; a program that imports `value` cannot bind it, which
 * is the package's refusal (ScrDiagnostic.exportOf). */
function fencedBundle(value: string): string {
  return `"use strict";
var __defProp = Object.defineProperty;
var __export = (target, all) => {
  for (var name in all) __defProp(target, name, { get: all[name], enumerable: true });
};
var src_exports = {};
__export(src_exports, { value: () => value });
module.exports = src_exports;
function Schema(kind) {
  this.kind = kind;
}
Schema.prototype.describe = function () {
  return this.kind;
};
function value() {
  return new Schema("${value}").describe();
}
0 && (module.exports = { value });
`;
}

function writePackage(dir: string, name: string, js: string, types: string | null): void {
  const at = join(dir, "node_modules", name);
  mkdirSync(at, { recursive: true });
  writeFileSync(
    join(at, "package.json"),
    JSON.stringify({
      name,
      version: "1.0.0",
      main: "index.js",
      ...(types === null ? {} : { types: "index.d.ts" }),
    }),
  );
  writeFileSync(join(at, "index.js"), js);
  if (types !== null) writeFileSync(join(at, "index.d.ts"), types);
}

/** Decorators in a JavaScript package: its own module refuses natively, which
 * is the lowering's island growth. `nested` also requires `fencelib`, which
 * the reload runs in the island's own program. */
function refusingPackage(nested = true): string {
  return `"use strict";
${nested ? 'const nested = require("fencelib");\n' : ""}function logged(method) { return method; }
class Thing {
  @logged
  value() { return "r"; }
}
exports.refuse = () => new Thing().value()${nested ? " + nested.value()" : ""};
`;
}

/** A package that compiles with a runtime fence in its top-level module
 * code: the fence rule islands it, never the lowering rule. */
const SURE_FENCE = `"use strict";
var stop = process.exit;
exports.value = function () { return typeof stop; };
`;

type Direct = "surefence" | "fenceddirect" | "conditionalmodel";

function fixture(direct: Direct = "surefence"): string {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-island-fold-"));
  scratch.push(dir);
  const withFenced = direct !== "conditionalmodel";
  writeFileSync(
    join(dir, "main.ts"),
    withFenced
      ? `import { refuse } from "refuser";
import { value } from "${direct}";

console.log(refuse(), value());
`
      : `import { refuse } from "refuser";
import { decorate } from "conditionalmodel";

console.log(refuse(), decorate({}).constructor === Object);
`,
  );
  writePackage(dir, "refuser", refusingPackage(), "export declare function refuse(): string;\n");
  // Reached only through `refuser`: the reload runs it in the island's own
  // program, so the fence rule never sees it and must not island it.
  writePackage(dir, "fencelib", fencedBundle("lib"), "export declare function value(): string;\n");
  // Imported by the program itself: the fence rule islands `surefence`, and
  // the program's use of `fenceddirect`'s export islands that one.
  if (withFenced) {
    writePackage(
      dir,
      direct,
      direct === "surefence" ? SURE_FENCE : fencedBundle("direct"),
      "export declare function value(): string;\n",
    );
  } else {
    // Imported by the program itself, but its object-model marker sits in a
    // function body: the module compiles natively, and a reload the island
    // set makes compile keeps it native.
    writePackage(
      dir,
      "conditionalmodel",
      `"use strict";
function withPrototype(target) {
  Object.setPrototypeOf(target, {});
  return target;
}
exports.decorate = (target) => withPrototype(target);
`,
      "export declare function decorate(target: object): object;\n",
    );
  }
  return dir;
}

/**
 * The sure-rule case: a refusing package the lowering islands, and a package
 * that compiles with a runtime fence in its top-level module code. The reload
 * then has no diagnostic at all, so the fence rule the fold applies is the
 * sure one, and a build with its growth is what a compiling build asks for.
 */
function sureFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-island-fold-sure-"));
  scratch.push(dir);
  writeFileSync(
    join(dir, "main.ts"),
    `import { refuse } from "refuser";
import { value } from "surefence";

console.log(refuse(), value());
`,
  );
  writePackage(
    dir,
    "refuser",
    refusingPackage(false),
    "export declare function refuse(): string;\n",
  );
  writePackage(dir, "surefence", SURE_FENCE, "export declare function value(): string;\n");
  return dir;
}

function build(
  fold: boolean,
  copyResult = false,
  direct: Direct = "surefence",
  failOn: string | null = null,
  dir = fixture(direct),
) {
  let firstLoads = 0;
  let reloads = 0;
  const rounds: string[][] = [];
  const factory: FrontendFactory = (entry, npmStatic, externalTypes, libraryNpmStatic, options) => {
    if (options?.islandPackages === undefined && options?.islandModules === undefined) firstLoads++;
    else {
      reloads++;
      rounds.push([...(options?.islandPackages ?? [])].sort());
    }
    const frontend = runFrontend(
      entry,
      loadProgram,
      npmStatic,
      externalTypes,
      libraryNpmStatic,
      options,
    );
    // An island build of `failOn` does not compile: a fence retry can fail
    // where the build that asked for it compiled, and the retry then keeps
    // that build with an SC8023 warning.
    if (failOn !== null && options?.islandPackages?.has(failOn) === true) {
      const failure: ScrDiagnostic = {
        code: "SC0001",
        message: "the island build rejects the program",
        loc: { file: entry, start: 0, end: 0 },
      };
      const failed: LowerResult = {
        module: null,
        diagnostics: [failure],
        runtimeFences: [],
        stats: { statementsTotal: 0, statementsFailed: 1, functionsSkipped: 0 },
      };
      return { ...frontend, lower: () => failed };
    }
    if (!copyResult) return frontend;
    // `fe.lower` returns the result wrapped in a copy when the program has
    // declaration-boundary notes (pipeline.ts: `{ ...lowered, performance }`).
    // The retry decision must still recognize the result it decided from.
    return { ...frontend, lower: (lowerOpts, valid) => ({ ...frontend.lower(lowerOpts, valid) }) };
  };
  const result = prepareExecutableModule(
    join(dir, "main.ts"),
    { outPath: join(dir, "main"), outDir: dir },
    null,
    process.platform,
    factory,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { foldFenceGrowth: fold },
  );
  // Paths differ per temp dir: compare diagnostics with the directory
  // replaced everywhere it appears (loc.file, message frames, rejects).
  const diagnostics = result.ok
    ? []
    : JSON.parse(JSON.stringify(result.diagnostics).split(dir).join("<dir>"));
  return {
    ok: result.ok,
    diagnostics,
    islands: result.ok ? (result.islands?.packages ?? []) : null,
    warnings: result.ok ? result.warnings.map((w) => w.code) : null,
    firstLoads,
    reloads,
    rounds,
  };
}

test("the merged round decides the fence growth exactly as the second reload does", () => {
  const off = build(false);
  const on = build(true);
  const copied = build(true, true);
  expect(off.diagnostics).toEqual([]);
  expect(on.diagnostics).toEqual([]);
  // The two-round sequence: the lowering grows `refuser`, and the reload,
  // which compiles, asks for `surefence`. `fencelib` is only reached through
  // `refuser`: the reload never compiles it, so no rule islands it, and it is
  // in the set by containment from the round `refuser` joins.
  expect(off.reloads).toBe(2);
  expect(off.rounds).toEqual([
    ["fencelib", "refuser"],
    ["fencelib", "refuser", "surefence"],
  ]);
  // The merged round decides both from the first pass: one reload fewer with
  // the set the second reload ends on.
  expect(on.reloads).toBe(1);
  expect(on.rounds).toEqual([["fencelib", "refuser", "surefence"]]);
  expect(on.ok).toBe(true);
  expect(on.islands).toEqual(["fencelib", "refuser", "surefence"]);
  expect(off.islands).toEqual(on.islands);
  // The first load is reused, not repeated: one load per compile either way.
  expect(on.firstLoads).toBe(1);
  expect(off.firstLoads).toBe(1);
  // A lowering result that comes back as a copy still carries the merged
  // decision: the round must not fall back to the lowering rule alone.
  expect(copied.reloads).toBe(1);
  expect(copied.rounds).toEqual([["fencelib", "refuser", "surefence"]]);
  expect(copied.islands).toEqual(on.islands);
}, 600_000);

// A pre-scan marker alone islands nothing, in a build that fails as in one
// that compiles: `conditionalmodel` has an object-model marker in a function
// body the program may never run, and stays native whichever way the round
// is decided.
test("a package with only a pre-scan marker stays native", () => {
  const off = build(false, false, "conditionalmodel");
  const on = build(true, false, "conditionalmodel");
  expect(off.diagnostics).toEqual([]);
  expect(on.diagnostics).toEqual([]);
  expect(off.rounds).toEqual([["fencelib", "refuser"]]);
  expect(off.islands).toEqual(["fencelib", "refuser"]);
  expect(on.reloads).toBe(1);
  expect(on.rounds).toEqual([["fencelib", "refuser"]]);
  expect(on.ok).toBe(true);
  expect(on.islands).toEqual(["fencelib", "refuser"]);
  expect(on.firstLoads).toBe(1);
}, 600_000);

// A package whose exports are defined at run time compiles, but the program
// cannot bind what it imports from it: the error is at the program's use and
// is the package's refusal. The round that sees it islands that package with
// the others, whether or not the package has a marker and whatever else in
// the program fails.
test("a use of an export a compiled package does not provide islands that package", () => {
  const off = build(false, false, "fenceddirect");
  const on = build(true, false, "fenceddirect");
  for (const built of [off, on]) {
    expect(built.diagnostics).toEqual([]);
    expect(built.ok).toBe(true);
    expect(built.reloads).toBe(1);
    expect(built.rounds).toEqual([["fenceddirect", "fencelib", "refuser"]]);
    expect(built.islands).toEqual(["fenceddirect", "fencelib", "refuser"]);
  }
}, 600_000);

// The sure rule folds the growth a compiling build asks for. A build with that
// growth can still fail, where the compiling build without it does not: the
// retry then falls back to the lowering's islands alone and the fence retry
// runs as it does without the fold, so the compiling build is kept with the
// SC8023 warning that names the islands it does not have.
test("a folded sure-fence build that fails keeps the compiling build with an SC8023 warning", () => {
  const dir = sureFixture();
  const off = build(false, false, "surefence", "surefence", dir);
  const on = build(true, false, "surefence", "surefence", dir);
  // The fold retries with the set the compiling build would ask for; that
  // build fails, and the retry goes back to the lowering's set, compiles,
  // and asks for the sure-fence retry that fails again.
  expect(on.ok).toBe(true);
  expect(on.diagnostics).toEqual([]);
  expect(on.islands).toEqual(["refuser"]);
  expect(on.warnings).toContain("SC8023");
  expect(on.reloads).toBe(3);
  expect(on.rounds).toEqual([["refuser", "surefence"], ["refuser"], ["refuser", "surefence"]]);
  // The two-round sequence ends in the same build and warning, one load
  // earlier.
  expect(off.ok).toBe(true);
  expect(off.islands).toEqual(on.islands);
  expect(off.warnings).toEqual(on.warnings);
  expect(off.reloads).toBe(2);
  expect(off.rounds).toEqual([["refuser"], ["refuser", "surefence"]]);
}, 600_000);
