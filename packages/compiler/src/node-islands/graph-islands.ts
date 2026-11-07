/* The island packages a decided set drags along through the module graph. */
import { resolveBareModule } from "../frontend/resolve.js";
import { isEsmFile } from "../frontend/lowering/lower-node-island.js";
import type { IslandPackage } from "./boundary.js";
import { packageDirOf, packageVersionOf } from "./origin.js";
import type { NodeIslandPolicy } from "./policy.js";
import type { PackageEdge } from "./scan.js";

/** Adds every package whose ES module imports an island CommonJS package to
 * `grown` (`--node-islands=auto` only): its native ES module would read the
 * island's bindings from the module's exports object, where Node gives it
 * the namespace the CommonJS facade builds (the lexed names, module.exports
 * as the default). */
export function growEsmImporters(
  policy: NodeIslandPolicy,
  compiled: ReadonlySet<string>,
  edges: readonly PackageEdge[] | undefined,
  grown: Map<string, IslandPackage>,
): void {
  if (edges === undefined) return;
  for (let added = true; added;) {
    added = false;
    for (const edge of edges) {
      const name = edge.to;
      if (!grown.has(name) || edge.fromDir === null || edge.shim) continue;
      const at = packageDirOf(edge.fromFile);
      if (at === null || grown.has(at.name) || !compiled.has(at.name)) continue;
      if (policy.forcedNative.has(at.name) || policy.unloaded.has(at.name)) continue;
      if (!isEsmFile(edge.fromFile)) continue;
      const target =
        resolveBareModule(edge.fromFile, name, "js-only") ??
        resolveBareModule(edge.fromFile, name, "js-only", "require");
      if (target === null || isEsmFile(target.typesFile)) continue;
      grown.set(at.name, {
        name: at.name,
        version: packageVersionOf(at.dir),
        dir: at.dir,
        class: "packaging",
        reason: `an ES module of the package imports the CommonJS island package '${name}'`,
      });
      added = true;
    }
  }
}
