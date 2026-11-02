// A round that grew the island set also decides the fence-report growth from
// the same lowering pass (WP9, node-islands/growth.ts's foldFenceGrowth), so
// a build reloads once instead of twice. The fence rule reads what the reload
// still compiles: a package the new islands reach only through themselves
// leaves the compiled program with them, so its fences are not a decision
// that round can make.
//
// This compiles one fixture through prepareExecutableModule with the fold on
// and off, and requires the merged round to island exactly what today's
// second reload does — one reload fewer, the same islands, both compiling.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { prepareExecutableModule } from "../src/executable/prepare.js";
import { runFrontend, type FrontendFactory } from "../src/frontend/pipeline.js";
import { loadProgram } from "../src/frontend/program-node.js";

const scratch: string[] = [];
afterEach(() => {
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true });
});

/** The ES-module-bundle prologue scriptc compiles natively only with runtime
 * fences (getters over live bindings, a constructor function with prototype
 * methods): a package the fence rule islands, never the lowering rule. */
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

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-island-fold-"));
  scratch.push(dir);
  writeFileSync(
    join(dir, "main.ts"),
    `import { refuse } from "refuser";
import { value } from "fenceddirect";

console.log(refuse(), value());
`,
  );
  // Decorators in a JavaScript package: its own module refuses natively,
  // which is the lowering's island growth.
  writePackage(
    dir,
    "refuser",
    `"use strict";
const nested = require("fencelib");
function logged(method) { return method; }
class Thing {
  @logged
  value() { return "r"; }
}
exports.refuse = () => new Thing().value() + nested.value();
`,
    "export declare function refuse(): string;\n",
  );
  // Reached only through `refuser`: the reload runs it in the island's own
  // program, so the fence rule never sees it and must not island it.
  writePackage(dir, "fencelib", fencedBundle("lib"), "export declare function value(): string;\n");
  // Imported by the program itself: the fence rule islands it.
  writePackage(
    dir,
    "fenceddirect",
    fencedBundle("direct"),
    "export declare function value(): string;\n",
  );
  return dir;
}

function build(fold: boolean, copyResult = false) {
  const dir = fixture();
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
    firstLoads,
    reloads,
    rounds,
  };
}

test("the merged round decides the fence-report growth exactly as the second reload does", () => {
  const off = build(false);
  const on = build(true);
  const copied = build(true, true);
  expect(off.diagnostics).toEqual([]);
  expect(on.diagnostics).toEqual([]);
  // Today's sequence: the lowering grows `refuser`, and the reload's fences
  // grow `fenceddirect`. `fencelib` is only reached through `refuser`, so the
  // reload never compiles it and never islands it.
  expect(off.reloads).toBe(2);
  expect(off.rounds).toEqual([["refuser"], ["fenceddirect", "refuser"]]);
  // The merged round decides both from the first pass: one reload fewer with
  // the set today's second reload ends on. A plain union of the two rules
  // would island `fencelib` too, on its markers alone.
  expect(on.reloads).toBe(1);
  expect(on.rounds).toEqual([["fenceddirect", "refuser"]]);
  expect(on.ok).toBe(true);
  expect(on.islands).toEqual(["fenceddirect", "refuser"]);
  expect(off.islands).toEqual(on.islands);
  // The first load is reused, not repeated: one load per compile either way.
  expect(on.firstLoads).toBe(1);
  expect(off.firstLoads).toBe(1);
  // A lowering result that comes back as a copy still carries the merged
  // decision: the round must not fall back to the lowering rule alone.
  expect(copied.reloads).toBe(1);
  expect(copied.rounds).toEqual([["fenceddirect", "refuser"]]);
  expect(copied.islands).toEqual(on.islands);
}, 600_000);
