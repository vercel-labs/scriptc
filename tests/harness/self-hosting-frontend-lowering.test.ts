import { execFile } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import type { LowerResult } from "../../packages/compiler/src/frontend/lowering/lowerer.js";

const root = join(import.meta.dirname, "../..");

test("the complete production frontend lowers with zero rejected statements", async () => {
  // This is the production reachable lowering pass, not a source-only scan
  // or a coverage run that can skip bodies. Run in a child so its synchronous
  // work cannot starve Vitest's worker RPC. Native execution of the complete
  // frontend is a separate bootstrap milestone.
  const frontend = pathToFileURL(join(root, "packages/compiler/src/frontend/")).href;
  const validator = pathToFileURL(join(root, "packages/compiler/src/ir/validate.ts")).href;
  const ffi = pathToFileURL(join(root, "packages/compiler/src/ffi/ffi-manifest.ts")).href;
  const { stdout, stderr } = await promisify(execFile)(
    process.execPath,
    [
      // The lowering holds about 3 GB of heap; Node's default limit is lower
      // on hosts with less memory.
      "--max-old-space-size=8192",
      "--import",
      "tsx",
      "--input-type=module",
      "--eval",
      `import { loadProgram, checkPreflight } from ${JSON.stringify(frontend + "program-node.ts")};
     import { lowerToIr } from ${JSON.stringify(frontend + "lowering/lowerer.ts")};
     import { validateModule } from ${JSON.stringify(validator)};
     import { loadFfiProfile } from ${JSON.stringify(ffi)};
     const ffi = loadFfiProfile(process.argv[2]);
     if (!ffi.ok) throw new Error(JSON.stringify(ffi.diagnostics));
     const load = loadProgram(process.argv[1]);
     try {
       const preflight = checkPreflight(load);
       if (preflight.length) throw new Error(JSON.stringify(preflight));
       if (load.startupCrash) throw new Error(JSON.stringify(load.startupCrash));
       const result = lowerToIr(load.program, load.entry, load.moduleOrder, {
         frontendServices: load.services, ffiImports: ffi.profile.functions,
       });
       console.log(JSON.stringify({ stats: result.stats, diagnostics: result.diagnostics, runtimeFences: result.runtimeFences,
         functions: result.module?.functions.length ?? 0,
         validation: result.module ? validateModule(result.module) : null }));
     } finally { load.dispose(); }`,
      join(root, "tests/fixtures/self-hosting/frontend-lowering.ts"),
      join(root, "packages/compiler/native/ts7-process.ffi.json"),
    ],
    { cwd: root, timeout: 900_000, maxBuffer: 8 * 1024 * 1024 },
  );
  expect(stderr).toBe("");
  const result = JSON.parse(stdout) as Pick<
    LowerResult,
    "stats" | "diagnostics" | "runtimeFences"
  > & { functions: number; validation: unknown[] | null };
  expect(result.diagnostics).toEqual([]);
  expect(result.runtimeFences).toEqual([]);
  expect(result.stats.statementsTotal).toBeGreaterThan(50_000);
  expect(result.stats.statementsFailed).toBe(0);
  expect(result.stats.functionsSkipped).toBe(0);
  expect(result.functions).toBeGreaterThan(1_000);
  expect(result.validation).toEqual([]);
}, 930_000);
