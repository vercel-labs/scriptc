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
import { packageDirOf, packageKeyOf, packageVersionOf } from "./origin.js";
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
 * imports load in Node, nothing to decide).
 *
 * `deferred` admits a package a require() loads only when that code runs (a
 * function body, a condition, a dynamic import()). A build keeps those for
 * the lowering, which decides them where it compiles them: islanding one
 * that never runs would refuse a program for a package it never touches. A
 * coverage analysis lowers every site, so such an edge is a refusal it is
 * about to report, and passing `deferred` makes its discovery lowering the
 * retry lowering. */
export function outsideGraphIslands(
  policy: NodeIslandPolicy,
  npmStatic: readonly NpmStaticStatus[],
  scan: NodeIslandScan,
  modules: ReadonlyMap<string, IslandModule>,
  known: ReadonlyMap<string, IslandPackage>,
  deferred = false,
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
    // The graph proves only a package the importing module loads whenever it
    // evaluates. A require() inside a function or under a condition, and a
    // dynamic import(), load their package only when that code runs; islanding
    // one that never runs would refuse a program that patches a process output
    // stream (SC8020) for a package it never touches. Those stay with the
    // lowering, which decides them where it compiles them.
    if (!edge.loads && !deferred) continue;
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

/** The packages only Node islands load, by name (unless islands are off):
 * a package that no natively compiled code imports, and that an island
 * package, an island module, or another such package imports, runs in the
 * island's Node by construction. It is part of the island set, so a value
 * of one of its declared types is an island value like any other: without
 * it, an object an island returns under such a type is checked into a
 * native record and refused at run time, and which of these packages a
 * build names depends on which rule looked at them first.
 *
 * The answer is a property of the program's import graph and of `islands`
 * alone, so every round derives it again from the first load's scan:
 * `scan.edges` holds the imports of every module the program loaded, and
 * `scan.insideEdges` those of the modules that left the program together
 * with a package the load refused.
 *
 * A package of `islands` itself is answered too when only islands load it
 * (a rule found a refusal of its own while its importer still compiled): it
 * is described the same way, so what a build says about a package inside
 * an island does not depend on whether a rule looked at it first. The
 * exception is a package whose importer is an island only because of it
 * (`follows`): that package is the reason for both and keeps it. A
 * package the policy marks keeps its marking. A build names them all in one
 * note (nodeIslandContainedNoteDiag).
 *
 * "Natively imported" is reachability from the program's own native modules
 * through packages that are not islands, over every import including the
 * deferred ones (a require() in a function, an import()): a package native
 * code may load is not inside an island, whatever else loads it. One that
 * both sides load stays what the other rules make it. A package the policy
 * keeps native or unloaded is left alone, as every other rule leaves it. */
export function containedIslands(
  policy: NodeIslandPolicy,
  scan: NodeIslandScan,
  islands: ReadonlyMap<string, IslandPackage>,
  modules: ReadonlyMap<string, IslandModule>,
): Map<string, IslandPackage> {
  const contained = new Map<string, IslandPackage>();
  if (policy.mode === "off" || (islands.size === 0 && modules.size === 0)) return contained;
  // An island installed outside node_modules (a linked workspace member)
  // has no package name in its files' paths: its directory names it.
  const linked: { dir: string; name: string }[] = [];
  for (const island of islands.values()) {
    const dir = island.dir.replaceAll("\\", "/").replace(/\/+$/, "");
    if (packageDirOf(`${dir}/package.json`) === null) linked.push({ dir, name: island.name });
  }
  const linkedOwner = (file: string): string | null => {
    if (linked.length === 0) return null;
    const path = file.replaceAll("\\", "/");
    return linked.find((l) => path.startsWith(`${l.dir}/`))?.name ?? null;
  };
  const dropped = new Set<string>();
  for (const m of scan.modules) if (m.dropped) dropped.add(m.file);
  // Who imports what: the program's native modules, the island modules, and
  // each package. A native module's imports are roots of the native side; an
  // island module's are roots of the island side.
  const nativeRoots: PackageEdge[] = [];
  const islandRoots: PackageEdge[] = [];
  const imports = new Map<string, PackageEdge[]>();
  const push = (name: string, edge: PackageEdge): void => {
    const known = imports.get(name);
    if (known === undefined) imports.set(name, [edge]);
    else known.push(edge);
  };
  for (const edge of [...scan.edges, ...(scan.insideEdges ?? [])]) {
    if (edge.shim || edge.toDir === null) continue;
    if (modules.has(edge.fromFile)) {
      islandRoots.push(edge);
      continue;
    }
    const from = packageKeyOf(edge.fromFile) ?? linkedOwner(edge.fromFile);
    if (from !== null) push(from, edge);
    else if (!dropped.has(edge.fromFile)) nativeRoots.push(edge);
  }
  const walk = (roots: readonly PackageEdge[], enter: (edge: PackageEdge) => boolean): void => {
    const queue: string[] = [];
    for (const edge of roots) if (enter(edge)) queue.push(edge.to);
    while (queue.length > 0) {
      const name = queue.pop()!;
      for (const edge of imports.get(name) ?? []) if (enter(edge)) queue.push(edge.to);
    }
  };
  // The native side: the packages native code reaches without passing
  // through an island, and the islands it imports (the boundary).
  const native = new Set<string>();
  const boundary = new Set<string>();
  walk(nativeRoots, (edge) => {
    if (islands.has(edge.to)) {
      // An island that is in the set only because its ES module imports a
      // CommonJS island (growEsmImporters) would compile without that
      // island, and its import would be a native one. So the island it
      // follows is on the boundary with it, and keeps the reason that made
      // both of them islands.
      let at: string | undefined = edge.to;
      while (at !== undefined && islands.has(at) && !boundary.has(at)) {
        boundary.add(at);
        at = islands.get(at)?.follows;
      }
      return false;
    }
    if (native.has(edge.to)) return false;
    native.add(edge.to);
    return true;
  });
  // The island side: everything an island reaches that the native side does
  // not, with the islands, island modules and contained packages that load
  // it.
  const loaders = new Map<string, { dir: string; by: Set<string> }>();
  const enter = (edge: PackageEdge): boolean => {
    const name = edge.to;
    if (native.has(name) || boundary.has(name)) return false;
    if (policy.forcedNative.has(name) || policy.unloaded.has(name)) return false;
    if (policy.forcedNode.has(name)) return false;
    const by = modules.has(edge.fromFile)
      ? edge.fromFile
      : (packageKeyOf(edge.fromFile) ?? linkedOwner(edge.fromFile) ?? edge.fromFile);
    if (by === name) return false;
    const known = loaders.get(name);
    if (known !== undefined) {
      known.by.add(by);
      return false;
    }
    loaders.set(name, { dir: edge.toDir!, by: new Set([by]) });
    // An island's own imports are roots of this walk already.
    return !islands.has(name);
  };
  const islandEdges: PackageEdge[] = [...islandRoots];
  for (const name of islands.keys())
    for (const edge of imports.get(name) ?? []) islandEdges.push(edge);
  walk(islandEdges, enter);
  for (const name of [...loaders.keys()].sort()) {
    const loader = loaders.get(name)!;
    const dir = islands.get(name)?.dir ?? loader.dir;
    const names = [...loader.by].sort();
    contained.set(name, {
      name,
      version: packageVersionOf(dir),
      dir,
      class: "packaging",
      reason:
        names.length === 1
          ? `only '${names[0]!}', which runs in a Node island, loads it`
          : `only code that runs in a Node island loads it (${names
              .slice(0, 3)
              .map((n) => `'${n}'`)
              .join(", ")}${names.length > 3 ? ", …" : ""})`,
    });
  }
  return contained;
}

/** An importer that grows along a sure island is sure too. */
export interface ESMGrowthOptions {
  /** The set the growth round started from: a package already islanded
   * before this round goes wherever the round goes. */
  known: ReadonlyMap<string, IslandPackage>;
  /** The packages whose island surely joins the build (their fence surely
   * fires): an importer of one joins it the same way. */
  sure?: Set<string>;
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
  sureOf?: ESMGrowthOptions,
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
        follows: name,
      });
      // It goes wherever that island goes, the sure-fence retry included.
      if (sureOf !== undefined && sureOf.sure !== undefined) {
        if (sureOf.known.has(name) || sureOf.sure.has(name)) sureOf.sure.add(at.name);
      }
      added = true;
    }
  }
}
