// An island round after the first only reads the no-island frontend to
// decide its islands, and that frontend is the same call with the same
// arguments in every round. So the first round captures the decision's
// inputs and the later rounds decide from the capture instead of loading
// and checking the whole program again, which on a large program is a
// multi-load npm-static ladder per round (retry-round analysis, slice 1).
//
// This compiles one real island fixture that retries twice through
// prepareExecutableModule, with the internal reuse switch on and off, and
// requires the same diagnostics and the same island reloads from both — with
// the first load once instead of once per round.
import { copyFileSync, cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { prepareExecutableModule } from "../src/executable/prepare.js";
import { runFrontend, type FrontendFactory } from "../src/frontend/pipeline.js";
import { loadProgram } from "../src/frontend/program-node.js";

const repoRoot = join(import.meta.dirname, "../../..");
const scratch: string[] = [];
afterEach(() => {
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true });
});

function build(reuse: boolean) {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-island-rounds-"));
  scratch.push(dir);
  cpSync(
    join(repoRoot, "tests/corpus/6829-node-island-declared-types/node_modules"),
    join(dir, "node_modules"),
    { recursive: true },
  );
  copyFileSync(
    join(repoRoot, "tests/fixtures/node-island/declared-types.ts"),
    join(dir, "main.ts"),
  );
  let firstLoads = 0;
  let reloads = 0;
  const factory: FrontendFactory = (entry, npmStatic, externalTypes, libraryNpmStatic, options) => {
    if (options?.islandPackages === undefined && options?.islandModules === undefined) firstLoads++;
    else reloads++;
    return runFrontend(entry, loadProgram, npmStatic, externalTypes, libraryNpmStatic, options);
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
    { reuseFirstLoad: reuse },
  );
  // Paths differ per temp dir: compare diagnostics with the directory
  // replaced everywhere it appears (loc.file, message frames, rejects).
  const diagnostics = result.ok
    ? []
    : JSON.parse(JSON.stringify(result.diagnostics).split(dir).join("<dir>"));
  return { ok: result.ok, diagnostics, firstLoads, reloads };
}

test("island rounds after the first reuse the no-island load and decide the same", () => {
  const off = build(false);
  const on = build(true);
  expect(off.firstLoads).toBeGreaterThanOrEqual(2); // the fixture runs at least two rounds
  expect(on.firstLoads).toBe(1);
  expect(on.reloads).toBe(off.reloads);
  expect(on.ok).toBe(off.ok);
  expect(on.diagnostics).toEqual(off.diagnostics);
}, 600_000);
