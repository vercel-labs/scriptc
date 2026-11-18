// A fence retry's own reload can meet a fence of its own, and the round
// driver runs it. The sure rule reads every compiling build, a fence retry's
// included: the round that islands a package makes its importers read the
// island's binding, and a module that reads it while it evaluates joins the
// island in turn.
//
// `9933-node-island-var-require-rewritten-later` is that shape: `pantry`
// loads a module by a computed specifier, and `shelf-late` binds what
// `require("pantry")` returns with `var`, reads it at module init and writes
// it again inside a function. The fence retry that islands `pantry` decides
// its own fences from the retrying round's push-down pass, so `shelf-late`
// joins it there and one reload carries both; a driver that took a reload's
// build as final without that pass compiled the unresolved binding into a
// program that throws when it runs.
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { prepareExecutableModule } from "../src/executable/prepare.js";
import { runFrontend, type FrontendFactory } from "../src/frontend/pipeline.js";
import { loadProgram } from "../src/frontend/program-node.js";

const corpus = join(
  import.meta.dirname,
  "../../../tests/corpus/9933-node-island-var-require-rewritten-later",
);

const scratch: string[] = [];
afterEach(() => {
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true });
});

function build() {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-island-fence-chain-"));
  scratch.push(dir);
  cpSync(join(corpus, "node_modules"), join(dir, "node_modules"), { recursive: true });
  cpSync(join(corpus, "main.ts"), join(dir, "main.ts"));
  const reloads: string[][] = [];
  const factory: FrontendFactory = (entry, npmStatic, externalTypes, libraryNpmStatic, options) => {
    if (options?.islandPackages !== undefined || options?.islandModules !== undefined)
      reloads.push([...(options.islandPackages ?? [])].sort());
    return runFrontend(entry, loadProgram, npmStatic, externalTypes, libraryNpmStatic, options);
  };
  const result = prepareExecutableModule(
    join(dir, "main.ts"),
    { outPath: join(dir, "main"), outDir: dir },
    null,
    process.platform,
    factory,
  );
  return { result, reloads };
}

test("a fence retry's reload meets its own fence, and the build islands both packages", () => {
  const { result, reloads } = build();
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.islands).toEqual({ packages: ["pantry", "shelf-late"], modules: [] });
  // One retry, whose push-down pass already meets the fence its new island
  // asks for: the reload carries both packages and the build that ends is
  // the one carrying both.
  expect(reloads).toEqual([["pantry", "shelf-late"]]);
}, 300_000);
