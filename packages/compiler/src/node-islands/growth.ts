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
 *    compile at all);
 *  - a runtime or object-model fence in a package's module, either one
 *    that surely fires ("sure": module-init code, or a fence that needs the
 *    runtime itself — what a native build islands for) or any fence the
 *    package's island class explains ("report": what a failed build tries);
 *  - the packages those islands drag along: a native ES module that imports
 *    an island CommonJS package (the ESM→CJS closure, graph-islands.ts).
 *
 * No rule stops at a size: every retry adds packages that were never
 * islanded, so growth is monotone and bounded by the project's package
 * count, and the retry reaches a fixed point. A numeric cap only turned a
 * refusal the automatic policy promised to island into a fatal SC2013.
 *
 * A build that grows both ways retries once with the union (foldFenceGrowth):
 * the fence rule's growth is decided from the same lowering pass, narrowed to
 * the packages the reload still compiles. A package the new islands reach
 * only through themselves is in a Node island by association: its modules
 * leave the compiled graph, so the next round no longer sees its fences. The
 * rule folded is the one that reload would apply: the fence report when it
 * still fails, the sure rule when the islands make it compile. */
import type { ScrDiagnostic } from "../diagnostics/diagnostic.js";
import type { SrcLoc } from "../ir/ir.js";
import { resolveBareModule } from "../frontend/resolve.js";
import type { IslandModule, IslandPackage } from "./boundary.js";
import { classifyDiagnostic, isIslandReasonCode } from "./classify.js";
import { growEsmImporters } from "./graph-islands.js";
import { packageDirOf, packageVersionOf } from "./origin.js";
import type { NodeIslandPolicy } from "./policy.js";
import { buildNodeIslandReport } from "./report.js";
import type { NodeIslandScan } from "./scan.js";
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
  /** The fence rule to apply: "sure" islands a package whose fence surely
   * fires (module-init code, or a fence that needs the runtime itself) —
   * the rule a native build islands for; "report" lets the package's
   * island class decide, the rule a failed build retries with. Absent with
   * `fences`: no fence rule. */
  fenceMode?: "sure" | "report";
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
  if (growth.diagnostics !== undefined) growFromLowering(ctx, grown, growth.diagnostics);
  if (growth.fences !== undefined)
    growFromFences(
      ctx,
      known,
      grown,
      growth.diagnostics ?? [],
      growth.fences,
      growth.fenceMode ?? "sure",
      growth.sure ?? null,
    );
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
  growEsmImporters(ctx.policy, compiled, ctx.scan.edges, grown);
}

/** WP2-9 (D18): the lowering growth rule's answer for ONE diagnostic, as a
 * per-pass test. A decision pass asks it after every diagnostic it reports;
 * a non-null package name means the retry that pass decides already islands
 * that package (growFromLowering grows it from this same diagnostic), so the
 * pass skips the package's remaining units. The test mirrors that branch
 * exactly, so it can only name a package the retry grows. */
export function islandReasonPackageOf(
  ctx: IslandGrowthContext,
  islands: ReadonlyMap<string, IslandPackage>,
): (diag: ScrDiagnostic) => string | null {
  // growIslandSet decides nothing outside auto mode, so neither may this.
  if (ctx.policy.mode !== "auto") return () => null;
  const compiled = compiledPackages(ctx.npm, NO_EXPLICIT);
  return (diag) => {
    if (!isIslandReasonCode(diag.code)) return null;
    const at = packageDirOf(diag.loc.file);
    if (at === null || !compiled.has(at.name) || islands.has(at.name)) return null;
    if (ctx.policy.forcedNative.has(at.name) || ctx.policy.unloaded.has(at.name)) return null;
    return at.name;
  };
}

/** The packages compiled natively whose runtime fences should make them
 * islands instead. "sure": a fence in top-level module code (which runs
 * when the module evaluates), or one that itself needs the runtime (R1) — a
 * use of a Node 24 global native code does not provide excepted, since its
 * fence throws honestly where it is reached. "report": the package's island
 * class decides (runtime or object-model, host-global fences excepted). */
function growFromFences(
  ctx: IslandGrowthContext,
  known: ReadonlyMap<string, IslandPackage>,
  grown: Map<string, IslandPackage>,
  diagnostics: readonly ScrDiagnostic[],
  fences: readonly ScrDiagnostic[],
  mode: "sure" | "report",
  sure: Set<string> | null,
): void {
  // With the sure rule, a fence in top-level module code is the only growth;
  // no fence at all means nothing to grow (the report rule still runs: the
  // package's island class may explain a fence the lowering deferred).
  if (mode === "sure" && fences.length === 0) return;
  // An explicit --npm-static request keeps its package native.
  const explicit = new Set(
    (ctx.explicitNpmStatic ?? []).map((name) => name.replace(/\.\.\.$/, "")),
  );
  const compiled = compiledPackages(ctx.npm, explicit);
  const fenced = new Map<string, boolean>();
  for (const d of fences) {
    const at = packageDirOf(d.loc.file);
    if (at === null || !compiled.has(at.name) || known.has(at.name)) continue;
    if (ctx.policy.forcedNative.has(at.name) || ctx.policy.unloaded.has(at.name)) continue;
    const reason = classifyDiagnostic(d, "fence");
    const runtime =
      d.moduleInit === true || (reason.class === "runtime" && reason.reason !== "host-global");
    fenced.set(at.name, (fenced.get(at.name) ?? false) || runtime);
    if (runtime) sure?.add(at.name);
  }
  if (mode === "sure" && fenced.size === 0) return;
  const report = buildNodeIslandReport({
    entry: ctx.entry,
    scan: ctx.scan,
    npm: ctx.npm,
    diagnostics,
    fences,
    policy: ctx.policy,
  });
  for (const island of report.islands) {
    const runtimeFence =
      mode === "sure" ? fenced.get(island.package) : (fenced.get(island.package) ?? false);
    if (runtimeFence === undefined || island.path === null) continue;
    if (!compiled.has(island.package) || known.has(island.package)) continue;
    if (ctx.policy.forcedNative.has(island.package) || ctx.policy.unloaded.has(island.package))
      continue;
    // With the sure rule, only fences that surely fire count: a gap fence
    // inside a function body may never run (jose's typed paths stay native,
    // DECISIONS.md 2026-10-21). The report rule lets the package's class
    // decide — a host-global fence excepted, for it never explains a
    // failure and islanding the package for it would only add a Node
    // requirement.
    if (mode === "sure" && !runtimeFence) continue;
    if (
      !runtimeFence &&
      !island.reasons.some(
        (r) => (r.class === "runtime" || r.class === "object-model") && r.reason !== "host-global",
      )
    )
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

/** The package name an island set keys a file's package by: `@types/<name>`
 * declarations type the package `<name>` (boundary.ts's
 * islandPackageOfFile). Null for a user module. */
function packageKeyOf(file: string): string | null {
  const at = packageDirOf(file);
  if (at === null) return null;
  if (!at.name.startsWith("@types/")) return at.name;
  const bare = at.name.slice("@types/".length);
  return bare.includes("__") ? `@${bare.replace("__", "/")}` : bare;
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
 * The rule the next round would apply depends on the failure it still has.
 * Remaining diagnostics are a failed build, and the fence-report rule islands
 * the package whose class accounts for that failure. No remaining diagnostic
 * means the islands made the reload compile, and a compiling build keeps its
 * conditional object-model dependencies native: only a fence that fires when
 * the module evaluates turns a package into an island then (the sure rule the
 * compiling build applies to itself). `sure` reports which rule was applied.
 * The sure rule folds the fence retry a compiling build would ask for, and a
 * build with that growth can fail where the compiling build without it does
 * not, so a retry that carries it can still fall back to `islands`. */
export function foldFenceGrowth(
  ctx: IslandGrowthContext,
  islands: ReadonlyMap<string, IslandPackage>,
  modules: ReadonlyMap<string, IslandModule>,
  growth: { diagnostics: readonly ScrDiagnostic[]; fences: readonly ScrDiagnostic[] },
): { islands: Map<string, IslandPackage>; sure: boolean } | null {
  const compiled = stillCompiled(ctx, islands, modules);
  const narrowed: IslandGrowthContext = {
    ...ctx,
    scan: {
      ...ctx.scan,
      modules: ctx.scan.modules.filter((m) => compiled(m.file)),
      edges: ctx.scan.edges.filter((e) => compiled(e.fromFile)),
    },
  };
  const diagnostics = growth.diagnostics.filter((d) => compiled(d.loc.file));
  const sure = diagnostics.length === 0;
  const grown = growIslandSet(narrowed, islands, {
    diagnostics,
    fences: growth.fences.filter((d) => compiled(d.loc.file)),
    fenceMode: sure ? "sure" : "report",
  });
  return grown === null ? null : { islands: grown, sure };
}
