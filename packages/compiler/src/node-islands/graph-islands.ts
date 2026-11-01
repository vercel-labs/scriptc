/* The island packages a program's module graph proves before any lowering
 * runs. A build decides its Node islands from the first load's scan and the
 * npm-static preflight (executable/prepare.ts) and a coverage analysis from
 * the same inputs (frontend/analysis.ts); a retry then grows the set from
 * the lowering's own refusals (loweringIslands). Deciding the provable
 * packages up front makes that first lowering the retry lowering, so a
 * build or analysis pays one lowering instead of two. */
import type { NpmStaticStatus } from "../coverage/report.js";
import { resolveBareModule } from "../frontend/resolve.js";
import { isEsmFile } from "../frontend/lowering/lower-node-island.js";
import type { IslandModule, IslandPackage } from "./boundary.js";
import { packageDirOf, packageVersionOf } from "./origin.js";
import type { NodeIslandPolicy } from "./policy.js";
import type { NodeIslandScan, PackageEdge } from "./scan.js";

/** The SC2013 reason a package the program's graph does not hold carries:
 * the message the lowering reports at its import site, and so the reason
 * the SC8001 note keeps whether the graph decided the island or a retry
 * grew it. */
function outsideGraphReason(name: string): string {
  return `SC2013: cannot compile npm package '${name}' statically: its implementation is not part of the compiled module graph`;
}

/** The island packages the program's module graph proves before the first
 * lowering (`--node-islands=auto` only), or null when it proves none: a
 * value import of an installed package whose implementation the frontend
 * did not put in the program is the SC2013 refusal the first lowering
 * reports at that import site and the retry then answers with an island.
 * `loweringIslands` stays the fallback for what only a lowering can see (a
 * package the graph holds that refuses to compile).
 *
 * `known` holds the islands earlier rounds grew, so a later round derives
 * nothing new; `modules` holds the island modules of this decision (their
 * imports load in Node, nothing to decide). */
export function outsideGraphIslands(
  policy: NodeIslandPolicy,
  npmStatic: readonly NpmStaticStatus[],
  scan: NodeIslandScan,
  modules: ReadonlyMap<string, IslandModule>,
  known: ReadonlyMap<string, IslandPackage>,
): Map<string, IslandPackage> | null {
  if (policy.mode !== "auto" || known.size > 16) return null;
  // The package directories whose sources the frontend has in the program:
  // an import of one of them is the frontend's to compile, and its refusal,
  // if any, is the lowering's to report.
  const inGraph = new Set<string>();
  for (const m of scan.modules) if (m.packageDir !== null && !m.dropped) inGraph.add(m.packageDir);
  const islandDirs = new Set<string>();
  for (const island of known.values()) islandDirs.add(island.dir);
  const grown = new Map<string, IslandPackage>();
  for (const edge of scan.edges) {
    const dir = edge.toDir;
    if (edge.shim || dir === null || inGraph.has(dir)) continue;
    const name = edge.to;
    if (grown.has(name) || known.has(name)) continue;
    if (policy.forcedNative.has(name) || policy.unloaded.has(name)) continue;
    // An island's own imports load in Node: nothing to decide here.
    if (modules.has(edge.fromFile)) continue;
    if (edge.fromDir !== null && islandDirs.has(edge.fromDir)) continue;
    grown.set(name, {
      name,
      version: packageVersionOf(dir),
      dir,
      class: "packaging",
      reason: outsideGraphReason(name),
    });
  }
  if (grown.size === 0) return null;
  const compiled = new Set(npmStatic.filter((e) => e.status === "static").map((e) => e.package));
  growEsmImporters(policy, compiled, scan.edges, grown);
  // The retry's growth budget (loweringIslands) bounds the set it may grow
  // further; a graph decision that spent it would turn a later refusal the
  // retry answers with an island into a build error. A graph that proves
  // more than the budget stays the discovery round it is today.
  if (grown.size + known.size > 16) return null;
  return grown;
}

/** Adds every package whose ES module imports an island CommonJS package to
 * `grown` (`--node-islands=auto` only): its native ES module would read the
 * island's bindings from the module's exports object, where Node gives it
 * the namespace the CommonJS facade builds (the lexed names, module.exports
 * as the default). The graph decision and the retry share the rule, so both
 * derive one set. */
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
