/* The island steps of an executable build. Lowering (prepare.ts) decides the
 * islands and emits the `nodeIsland.*` calls and the module tree; what
 * remains needs the build's output and the libnode pack, and happens here,
 * once, for the Node-hosted and the self-hosted driver alike:
 *
 *   1. the libnode pack the executable loads is found, checked and recorded
 *      (node-islands/libnode.ts), and copied beside the output for
 *      `--libnode=beside`;
 *   2. the deferred island modules are probed in that pack and each load
 *      becomes a deferred one with its interface snapshot or an eager one
 *      (node-islands/snapshot.ts);
 *   3. the island module tree is read for the executable to carry, or
 *      placed beside the output (node-islands/modules.ts), with the load
 *      plan Node's resolver answers from (node-islands/load-plan.ts).
 *
 * A module that left lowering with an island record and no island call
 * loses the record. */
import { basename, dirname } from "node:path";
import type { CompileOutputKind } from "../compile-types.js";
import {
  nodeIslandModuleDiag,
  nodeIslandNodeDiag,
  type ScrDiagnostic,
} from "../diagnostics/diagnostic.js";
import type { IrModule } from "../ir/ir.js";
import { moduleRuntimeFeatures } from "../ir/runtime-features.js";
import {
  libnodeProbePack,
  libnodeRecordFor,
  nodeIslandPackHintFor,
} from "../node-islands/libnode.js";
import { planNodeIslandLoads } from "../node-islands/load-plan.js";
import { placeNodeIslandModules, readNodeIslandModules } from "../node-islands/modules.js";
import { finalizeDeferredIslands } from "../node-islands/snapshot.js";

export interface IslandBuildRequest {
  outputKind: CompileOutputKind;
  outPath: string;
  /** `--libnode`. */
  libnode: string | undefined;
  /** The native target the build emits for, whose libnode pack it records
   * (libnode.ts); asked only of a program that calls into Node. */
  target: () => string;
  /** The first place the program reached into Node
   * (PreparedExecutableModule.nodeIslandUse), which SC8005's hint names
   * when no pack can be recorded. */
  nodeIslandUse?: { file: string; api: string };
}

export type FinishedIslands =
  | {
      ok: true;
      /** The module tree's files, for an executable or object that carries
       * them itself (the emitter's `nodeIslandModuleData`). */
      moduleData?: Uint8Array;
    }
  | { ok: false; diagnostic: ScrDiagnostic };

/** Runs the island steps on `mod` in place. */
export function finishNodeIslands(
  mod: IrModule,
  entryPath: string,
  request: IslandBuildRequest,
): FinishedIslands {
  if (mod.nodeIsland === undefined) return { ok: true };
  const { outputKind, outPath, libnode } = request;
  const projectDir = dirname(entryPath);
  // Calls into Node record the libnode pack an executable loads at run
  // time. IR, LLVM and object outputs need no pack: their record stays
  // empty, and SCRIPTC_LIBNODE supplies the pack when such a program runs.
  if (!moduleRuntimeFeatures(mod).nodeIsland) {
    delete mod.nodeIsland;
    return { ok: true };
  }
  if (outputKind === "exe") {
    const target = request.target();
    const recorded = libnodeRecordFor(target, libnode, outPath, process.env, projectDir);
    if (typeof recorded === "string")
      return {
        ok: false,
        diagnostic: nodeIslandNodeDiag(
          recorded,
          entryPath,
          nodeIslandPackHintFor(target, request.nodeIslandUse),
        ),
      };
    mod.nodeIsland = { ...mod.nodeIsland, ...recorded };
    // Deferred island modules (scope-B NI-7): probed in the same pack.
    finalizeDeferredIslands(mod, entryPath, libnodeProbePack(libnode, process.env, projectDir));
  } else {
    // IR, LLVM and object outputs have no pack to probe with: eager.
    finalizeDeferredIslands(mod, entryPath, null);
  }
  // The island module tree ships with the program: beside the executable
  // with --libnode=beside, else inside it (node-islands/modules.ts). What
  // Node's resolver answers for the tree is computed once and shipped as
  // one more of its files (node-islands/load-plan.ts).
  const modules = mod.nodeIsland.modules;
  if (modules === undefined || outputKind === "ir") return { ok: true };
  const generated = planNodeIslandLoads(modules);
  const entryLoc = { file: entryPath, start: 0, end: 0 };
  if (outputKind === "exe" && libnode === "beside") {
    const problem = placeNodeIslandModules(modules, `${outPath}.libnode/modules`, generated);
    if (problem !== null) return { ok: false, diagnostic: nodeIslandModuleDiag(problem, entryLoc) };
    modules.location = `$ORIGIN/${basename(outPath)}.libnode/modules`;
    return { ok: true };
  }
  const data = readNodeIslandModules(modules, generated);
  if (typeof data === "string")
    return { ok: false, diagnostic: nodeIslandModuleDiag(data, entryLoc) };
  return { ok: true, moduleData: data };
}
