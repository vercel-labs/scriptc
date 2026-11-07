/* One island-growth decision for a build and a coverage analysis. A build
 * starts from the packages its first load refused or the policy marks, and
 * grows the set between retries from what each lowering saw (executable/
 * prepare.ts); a coverage analysis lowers with the same set and must grow it
 * the same way, or it reports refusals for code the build runs in Node
 * (frontend/analysis.ts). The rules:
 *
 *  - a preflight refusal at an import statement of a natively compiled
 *    package (SC1013): the importer cannot be represented natively;
 *  - a package outside the compiled module graph (an SC2013 naming it);
 *  - a package-internal island-reason refusal (its own module does not
 *    compile at all), and a use of an export the package's compiled module
 *    does not provide as a binding (the use cannot compile against it);
 *  - a runtime fence in a package's module that surely fires: one in
 *    module-init code, or one that needs the runtime itself. A build that
 *    fails and a build that compiles apply the same rule: whether a package
 *    is an island does not depend on an error elsewhere in the program, and
 *    a pre-scan marker alone moves no package (it names a construct that
 *    may need Node, and most uses of those constructs compile);
 *  - the packages those islands drag along: a native ES module that imports
 *    an island CommonJS package (the ESM→CJS closure, graph-islands.ts).
 *
 * The packages only islands load join the set where it is assembled
 * (graph-islands.ts's containedIslands), not here: they are derived from the
 * set, not grown.
 *
 * No rule stops at a size: every retry adds packages that were never
 * islanded, so growth is monotone and bounded by the project's package
 * count, and the retry reaches a fixed point. A numeric cap only turned a
 * refusal the automatic policy promised to island into a fatal SC2013.
 *
 * A build that grows both ways retries once with the union (foldFenceGrowth):
 * the fence rule's growth is decided from the same lowering pass, narrowed to
 * the packages the reload still compiles. A package the new islands reach
 * only through themselves is in a Node island by containment: its modules
 * leave the compiled graph, so the next round no longer sees its fences. */
import { deferredOperationsDivergenceDiag, type ScrDiagnostic } from "../diagnostics/diagnostic.js";
import { dirname, relative } from "node:path";
import type { SrcLoc } from "../ir/ir.js";
import { resolveBareModule } from "../frontend/resolve.js";
import type { IslandModule, IslandPackage } from "./boundary.js";
import { classifyDiagnostic, isIslandReasonCode } from "./classify.js";
import { growEsmImporters } from "./graph-islands.js";
import { packageDirOf, packageKeyOf, packageVersionOf } from "./origin.js";
import type { NodeIslandPolicy } from "./policy.js";
import { buildNodeIslandReport } from "./report.js";
import { scannedPackageDir, type NodeIslandScan } from "./scan.js";
import { describe } from "./summary.js";

/** A dependency's native compilation outcome (coverage/report.ts's
 * NpmStaticStatus). */
interface NpmOutcome {
  package: string;
  status: "static" | "refused";
  detail?: string;
}

/** What the growth rules read from the frontend that saw the program. */
export interface IslandGrowthContext {
  entry: string;
  policy: NodeIslandPolicy;
  /** The detector's scan: the package edges for the ESM→CJS closure, and
   * the report the fence rule reads a package's island class from. */
  scan: NodeIslandScan;
  /** Its native compilation outcomes per dependency. */
  npm: readonly NpmOutcome[];
  /** The import site of each dependency (a package with no report
   * directory resolves from it). */
  npmImportSites: ReadonlyMap<string, SrcLoc>;
  /** The explicit `--npm-static` request: those packages stay native
   * (the fence rule outranks only an automatic island). */
  explicitNpmStatic?: readonly string[];
  /** The program's source texts, for the preflight rule's import
   * statement. */
  sourceTexts?: () => ReadonlyMap<string, string>;
}

/** What a lowering saw, the inputs the rules grow the set from. */
export interface IslandGrowth {
  /** Preflight refusals of the program (SC1013). */
  preflight?: readonly ScrDiagnostic[];
  /** The lowering's diagnostics: an SC2013 names a package outside the
   * compiled module graph; any other island reason inside a compiled
   * package is that package's own refusal. */
  diagnostics?: readonly ScrDiagnostic[];
  /** The lowering's runtime fences (refusals deferred to the operation
   * that reaches them). */
  fences?: readonly ScrDiagnostic[];
  /** The lowering's runtime fences, for a caller that applies the fence
   * rule in a separate step: a package the lowering rule names for a use of
   * its export keeps the reason of its own fence that surely fires, when it
   * has one. */
  ownFences?: readonly ScrDiagnostic[];
  /** Receives every package whose fence surely fires, for the caller's
   * sure-fence retry. */
  sure?: Set<string>;
}

/** The island set grown from what a lowering saw, or null when nothing
 * grows (`--node-islands=auto` only). `known` is the set the round started
 * from; the returned map is a copy of it with the growth added. */
export function growIslandSet(
  ctx: IslandGrowthContext,
  known: ReadonlyMap<string, IslandPackage>,
  growth: IslandGrowth,
): Map<string, IslandPackage> | null {
  if (ctx.policy.mode !== "auto") return null;
  const grown = new Map(known);
  if (growth.preflight !== undefined && growth.preflight.length > 0)
    growFromPreflight(ctx, grown, growth.preflight);
  // Both rules run the ESM→CJS closure over the set as it stands, so they
  // run even when the lowering saw nothing (the closure grows an importer of
  // an island the set already holds).
  if (growth.diagnostics !== undefined)
    growFromLowering(ctx, grown, growth.diagnostics, growth.fences ?? growth.ownFences ?? []);
  if (growth.fences !== undefined)
    growFromFences(ctx, known, grown, growth.diagnostics ?? [], growth.fences, growth.sure ?? null);
  return grown.size === known.size ? null : grown;
}

/** The dependencies the frontend compiled natively. `explicit` holds the
 * packages the user asked to keep native. */
function compiledPackages(npm: readonly NpmOutcome[], explicit: ReadonlySet<string>): Set<string> {
  const compiled = new Set<string>();
  for (const e of npm) {
    if (e.status === "static" && !explicit.has(e.package)) compiled.add(e.package);
  }
  return compiled;
}

const NO_EXPLICIT: ReadonlySet<string> = new Set();

/** A refusal in the importer of a natively compiled package (SC1013): the
 * package runs in a Node island instead. */
function growFromPreflight(
  ctx: IslandGrowthContext,
  grown: Map<string, IslandPackage>,
  preflight: readonly ScrDiagnostic[],
): void {
  const compiled = compiledPackages(ctx.npm, NO_EXPLICIT);
  if (compiled.size === 0) return;
  const texts = ctx.sourceTexts?.();
  if (texts === undefined) return;
  for (const d of preflight) {
    if (d.code !== "SC1013") continue;
    const text = texts.get(d.loc.file);
    if (text === undefined) continue;
    // The import statement around the diagnostic: its module specifier.
    const start = text.lastIndexOf("import", d.loc.start);
    const end = text.indexOf(";", d.loc.end);
    const stmt = text.slice(start < 0 ? d.loc.start : start, end < 0 ? text.length : end);
    const m = /\bfrom\s*["']([^"']+)["']/.exec(stmt);
    if (m === null) continue;
    const spec = m[1]!;
    const name = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]!;
    if (!compiled.has(name) || grown.has(name)) continue;
    if (ctx.policy.forcedNative.has(name) || ctx.policy.unloaded.has(name)) continue;
    const site = ctx.npmImportSites.get(name);
    const jsEntry = site === undefined ? null : resolveBareModule(site.file, spec, "js-only");
    const at = jsEntry === null ? null : packageDirOf(jsEntry.typesFile);
    if (at === null) continue;
    grown.set(name, {
      name,
      version: packageVersionOf(at.dir),
      dir: at.dir,
      class: "gap",
      reason: `${d.code}: ${d.message}`,
    });
  }
}

/** The packages the lowering said are not part of its compiled program: an
 * SC2013 names a package outside the module graph, and an island reason
 * inside a compiled package's own module is that package's refusal. */
function growFromLowering(
  ctx: IslandGrowthContext,
  grown: Map<string, IslandPackage>,
  diagnostics: readonly ScrDiagnostic[],
  fences: readonly ScrDiagnostic[],
): void {
  const compiled = compiledPackages(ctx.npm, NO_EXPLICIT);
  for (const d of diagnostics) {
    // A use of a package outside the compiled module graph (an import()
    // the frontend did not compile): that package runs in an island.
    const named = d.code === "SC2013" ? /npm package '([^']+)'/.exec(d.message) : null;
    if (named !== null) {
      const name = named[1]!;
      if (grown.has(name) || ctx.policy.forcedNative.has(name) || ctx.policy.unloaded.has(name))
        continue;
      const js =
        resolveBareModule(d.loc.file, name, "js-only") ??
        resolveBareModule(d.loc.file, name, "js-only", "require");
      const at = js === null ? null : packageDirOf(js.typesFile);
      if (at === null || at.name !== name) continue;
      grown.set(name, {
        name,
        version: packageVersionOf(at.dir),
        dir: at.dir,
        class: "packaging",
        reason: `${d.code}: ${d.message}`,
      });
      continue;
    }
    if (!isIslandReasonCode(d.code)) continue;
    // A use of an export of a compiled package is that package's refusal,
    // not the refusal of the module the use is in (below).
    if (d.exportOf !== undefined && compiled.has(d.exportOf.package)) continue;
    const at = packageDirOf(d.loc.file);
    if (at === null || !compiled.has(at.name) || grown.has(at.name)) continue;
    if (ctx.policy.forcedNative.has(at.name) || ctx.policy.unloaded.has(at.name)) continue;
    const reason = classifyDiagnostic(d, "refusal");
    grown.set(at.name, {
      name: at.name,
      version: packageVersionOf(at.dir),
      dir: at.dir,
      class: reason.class,
      reason: describe(reason),
    });
  }
  // A use of an export that a compiled package's module does not provide as
  // a binding (ScrDiagnostic.exportOf): the refusal is that package's,
  // wherever the use is. What the package's own modules say comes first: a
  // refusal in them named it above, and a fence in them that surely fires is
  // its reason here.
  let ownFence: Map<string, ScrDiagnostic> | null = null;
  for (const d of diagnostics) {
    if (d.exportOf === undefined || !isIslandReasonCode(d.code)) continue;
    const exporter = d.exportOf.package;
    if (!compiled.has(exporter) || grown.has(exporter)) continue;
    if (ctx.policy.forcedNative.has(exporter) || ctx.policy.unloaded.has(exporter)) continue;
    const dir = scannedPackageDir(ctx.scan, exporter);
    if (dir === null) continue;
    if (ownFence === null) {
      ownFence = new Map();
      for (const fence of fences) {
        const at = packageDirOf(fence.loc.file);
        if (at !== null && !ownFence.has(at.name) && fenceIslandsPackage(fence))
          ownFence.set(at.name, fence);
      }
    }
    const fence = ownFence.get(exporter);
    if (fence !== undefined) {
      const reason = classifyDiagnostic(fence, "fence");
      grown.set(exporter, {
        name: exporter,
        version: packageVersionOf(dir),
        dir,
        class: reason.class,
        reason: describe(reason),
      });
      continue;
    }
    grown.set(exporter, {
      name: exporter,
      version: packageVersionOf(dir),
      dir,
      class: "gap",
      reason: `its export '${d.exportOf.name}' has no native binding form (used at ${siteOf(ctx, d.loc)})`,
      named: true,
    });
  }
  growEsmImporters(ctx.policy, compiled, ctx.scan.edges, grown);
}

/** A use site as a note names it: the file relative to the entry's
 * directory, with the line and column when the source text is at hand. */
function siteOf(ctx: IslandGrowthContext, loc: SrcLoc): string {
  const file = relative(dirname(ctx.entry), loc.file).replaceAll("\\", "/");
  const texts = ctx.sourceTexts?.();
  if (texts === undefined) return file;
  const text = texts.get(loc.file);
  if (text === undefined || loc.start < 0 || loc.start > text.length) return file;
  let line = 1;
  let lineStart = 0;
  for (let i = text.indexOf("\n"); i >= 0 && i < loc.start; i = text.indexOf("\n", i + 1)) {
    line++;
    lineStart = i + 1;
  }
  return `${file}:${line}:${loc.start - lineStart + 1}`;
}

/** The packages an explicit `--npm-static` list names: the ones the user
 * asked to keep native. Undefined for the automatic selection. */
export function explicitNpmStaticOf(
  requested: readonly string[] | "auto" | undefined,
): readonly string[] | undefined {
  if (requested === undefined || typeof requested === "string") return undefined;
  return requested;
}

/** An explicit `--npm-static` request keeps its package native: the user
 * asked for its native compilation, deferred refusals included. */
function explicitlyStatic(explicit: readonly string[] | undefined): Set<string> {
  return new Set((explicit ?? []).map((name) => name.replace(/\.\.\.$/, "")));
}

/** Whether a reached runtime fence makes its package a Node island: a fence
 * in top-level module code, which throws when the module evaluates, or one
 * that itself needs the JavaScript runtime (R1; a use of a Node 24 global
 * native code does not provide excepted, since its fence throws honestly
 * where it is reached). */
function fenceIslandsPackage(d: ScrDiagnostic): boolean {
  if (d.moduleInit === true) return true;
  const reason = classifyDiagnostic(d, "fence");
  return reason.class === "runtime" && reason.reason !== "host-global";
}

/** The packages a build keeps native with runtime fences the program can
 * reach, none of which islands the package (`fenceIslandsPackage`): one
 * SC6006 warning each, at the package's import, with the number of such
 * operations and the first. The build ships those throws, and says so; a
 * coverage analysis reports the same list. A package the user named in
 * `--npm-static` asked for its fences and is not reported; a package with
 * a fence that surely fires is the fence rule's (it runs in an island, or
 * the build that kept it native says so with SC8023). */
export function deferredFenceWarnings(
  entry: string,
  policy: NodeIslandPolicy,
  npm: readonly NpmOutcome[],
  explicitNpmStatic: readonly string[] | undefined,
  npmImportSites: ReadonlyMap<string, SrcLoc>,
  fences: readonly ScrDiagnostic[],
  islanded: ReadonlyMap<string, IslandPackage>,
): ScrDiagnostic[] {
  const compiled = compiledPackages(npm, explicitlyStatic(explicitNpmStatic));
  // The reached fences by package, in the order the lowering reported them.
  const fenced = new Map<string, { count: number; first: ScrDiagnostic; islands: boolean }>();
  for (const d of fences) {
    const at = packageDirOf(d.loc.file);
    if (at === null || !compiled.has(at.name) || policy.unloaded.has(at.name)) continue;
    const islands = fenceIslandsPackage(d);
    const known = fenced.get(at.name);
    if (known === undefined) fenced.set(at.name, { count: 1, first: d, islands });
    else {
      known.count++;
      known.islands ||= islands;
    }
  }
  const out: ScrDiagnostic[] = [];
  for (const [name, fence] of fenced) {
    if (fence.islands || islanded.has(name)) continue;
    out.push(
      deferredOperationsDivergenceDiag(
        name,
        fence.count,
        fence.first,
        npmImportSites.get(name) ?? { file: entry, start: 0, end: 0 },
      ),
    );
  }
  return out;
}

/** The packages compiled natively whose runtime fences make them islands
 * instead (`fenceIslandsPackage`). A gap or object-model fence inside a
 * function body may never run, so its package stays native (jose's typed
 * paths, DECISIONS.md 2026-10-21) and is reported (`deferredFenceWarnings`). */
function growFromFences(
  ctx: IslandGrowthContext,
  known: ReadonlyMap<string, IslandPackage>,
  grown: Map<string, IslandPackage>,
  diagnostics: readonly ScrDiagnostic[],
  fences: readonly ScrDiagnostic[],
  sure: Set<string> | null,
): void {
  if (fences.length === 0) return;
  const compiled = compiledPackages(ctx.npm, explicitlyStatic(ctx.explicitNpmStatic));
  // The packages with a fence that surely fires, and whether any package
  // the rule may island holds a fence at all.
  const fenced = new Set<string>();
  let candidates = false;
  for (const d of fences) {
    const at = packageDirOf(d.loc.file);
    if (at === null || !compiled.has(at.name) || known.has(at.name)) continue;
    if (ctx.policy.forcedNative.has(at.name) || ctx.policy.unloaded.has(at.name)) continue;
    candidates = true;
    if (!fenceIslandsPackage(d)) continue;
    fenced.add(at.name);
    sure?.add(at.name);
  }
  if (!candidates) return;
  // The island's class and reason are the report's (the decisive class
  // first), as its SC8001 note prints them.
  const report = buildNodeIslandReport({
    entry: ctx.entry,
    scan: ctx.scan,
    npm: ctx.npm,
    diagnostics,
    fences,
    policy: ctx.policy,
  });
  for (const island of report.islands) {
    if (!fenced.has(island.package) || island.path === null) continue;
    if (!compiled.has(island.package) || known.has(island.package)) continue;
    if (ctx.policy.forcedNative.has(island.package) || ctx.policy.unloaded.has(island.package))
      continue;
    grown.set(island.package, {
      name: island.package,
      version: island.version,
      dir: island.path,
      class: island.class,
      reason: island.reason,
    });
  }
  growEsmImporters(ctx.policy, compiled, ctx.scan.edges, grown, {
    known,
    ...(sure !== null ? { sure } : {}),
  });
}

/** Whether a file belongs to a package a reload with `islands` still
 * compiles. A package that runs in a Node island is loaded for its
 * declarations only: its modules, and the modules of every package that only
 * its modules import, leave the compiled graph. A refusal or fence anchored
 * in one of those is not a diagnostic that round's lowering can report. A
 * user module is compiled, except an island module or one the
 * drop-and-reload loop removed. */
export function stillCompiled(
  ctx: IslandGrowthContext,
  islands: ReadonlyMap<string, IslandPackage>,
  modules: ReadonlyMap<string, IslandModule>,
): (file: string) => boolean {
  const notCompiled = new Set<string>(modules.keys());
  for (const m of ctx.scan.modules) if (m.dropped) notCompiled.add(m.file);
  // The imports of each package, and of user code, so the walk visits every
  // reachable package once. User code keeps its own list rather than a null
  // key: a collection keyed by `string | null` would make that union a
  // tagged box throughout the self-hosted compiler (nullable-unions.ts).
  const imports = new Map<string, { to: string; fromFile: string }[]>();
  const userImports: { to: string; fromFile: string }[] = [];
  for (const edge of ctx.scan.edges) {
    if (edge.shim || edge.toDir === null) continue;
    const from = packageKeyOf(edge.fromFile);
    const hop = { to: edge.to, fromFile: edge.fromFile };
    if (from === null) {
      userImports.push(hop);
      continue;
    }
    const known = imports.get(from);
    if (known === undefined) imports.set(from, [hop]);
    else known.push(hop);
  }
  const compiled = new Set<string>();
  const queue: string[] = [];
  const visit = (name: string): void => {
    if (islands.has(name) || compiled.has(name)) return;
    compiled.add(name);
    queue.push(name);
  };
  for (const hop of userImports) if (!notCompiled.has(hop.fromFile)) visit(hop.to);
  while (queue.length > 0) {
    const name = queue.pop()!;
    for (const hop of imports.get(name) ?? []) if (!notCompiled.has(hop.fromFile)) visit(hop.to);
  }
  return (file: string): boolean => {
    if (notCompiled.has(file)) return false;
    const name = packageKeyOf(file);
    return name === null || compiled.has(name);
  };
}

/** The island set a prepared round retries with when both growth rules grew
 * it: the lowering's growth plus the fence growth the *next* round would
 * decide (D4, the pi build-speed plan's WP9). That round lowers with
 * `islands` islanded, so it reads what its program still holds — the
 * diagnostics and fences a reload can still report, and the scan modules and
 * edges of the packages it still compiles. Null when the fence rule grows
 * nothing further.
 *
 * Narrowing the scan matters as much as the diagnostics: the fence rule
 * reads a package's island reasons from its markers, so a package the reload
 * no longer compiles would be islanded on its markers alone — the plain
 * union this filter exists to prevent.
 *
 * The rule is the same whatever the reload does, and what a failure of the
 * build that carries the growth means is not. Remaining diagnostics are a
 * build that fails either way: the islands' build is the one reported.
 * No remaining diagnostic means the islands made the reload compile
 * (`compiles`): the growth is then the fence retry a compiling build asks
 * for, and a build with it can fail where the compiling build without it
 * does not, so a retry that carries it can still fall back to `islands`. */
export function foldFenceGrowth(
  ctx: IslandGrowthContext,
  islands: ReadonlyMap<string, IslandPackage>,
  modules: ReadonlyMap<string, IslandModule>,
  growth: { diagnostics: readonly ScrDiagnostic[]; fences: readonly ScrDiagnostic[] },
): { islands: Map<string, IslandPackage>; compiles: boolean } | null {
  const compiled = stillCompiled(ctx, islands, modules);
  const narrowed: IslandGrowthContext = {
    ...ctx,
    scan: {
      ...ctx.scan,
      modules: ctx.scan.modules.filter((m) => compiled(m.file)),
      edges: ctx.scan.edges.filter((e) => compiled(e.fromFile)),
    },
  };
  // A refusal about a package `islands` holds is one the reload no longer
  // has either: the package's uses then compile against its island.
  const diagnostics = growth.diagnostics.filter(
    (d) => compiled(d.loc.file) && !(d.exportOf !== undefined && islands.has(d.exportOf.package)),
  );
  const grown = growIslandSet(narrowed, islands, {
    diagnostics,
    fences: growth.fences.filter((d) => compiled(d.loc.file)),
  });
  return grown === null ? null : { islands: grown, compiles: diagnostics.length === 0 };
}
