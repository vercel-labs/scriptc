/* One island-growth decision for a build and a coverage analysis. A build
 * starts from the packages its first load refused or the policy marks, and
 * grows the set between retries from what each lowering saw (executable/
 * prepare.ts); a coverage analysis lowers with the same set and grows it the
 * same way, so it reports the islands the build runs (frontend/analysis.ts).
 * The rules:
 *
 *  - a preflight refusal at an import statement of a natively compiled
 *    package (SC1013): the importer cannot be represented natively;
 *  - a package outside the compiled module graph (an SC2013 naming it);
 *  - a package-internal island-reason refusal (its own module does not
 *    compile at all);
 *  - a runtime fence the lowering reached in a natively compiled package
 *    that surely fires or needs the runtime itself (`fenceIslandsPackage`):
 *    the package runs in Node, where the operation works. Every other
 *    reached fence stays a throw at the operation that reaches it, and the
 *    build says so (`deferredFenceWarnings`, SC6006). A package the user
 *    named in `--npm-static` stays native with its fences, unreported (the
 *    explicit request for them);
 *  - for a lowering that failed and that no other rule explains, once per
 *    build: the compiled packages whose island class is the runtime or a
 *    mutable object model (`explain`);
 *  - the packages those islands drag along: a native ES module that imports
 *    an island CommonJS package (the ESM→CJS closure, graph-islands.ts).
 *
 * No rule stops at a size: every retry adds packages that were never
 * islanded, so growth is monotone and bounded by the project's package
 * count, and the retry reaches a fixed point. A numeric cap only turned a
 * refusal the automatic policy promised to island into a fatal SC2013.
 *
 * Where the policy does not let a package run in Node that the fence rule
 * would island (`--native`, `--node-islands=explicit` or `off`),
 * `fenceViolations` names the refusal a build fails with instead. */
import {
  deferredOperationsDivergenceDiag,
  nativePackageDiag,
  nodeIslandsOffDiag,
  type ScrDiagnostic,
} from "../diagnostics/diagnostic.js";
import type { SrcLoc } from "../ir/ir.js";
import { resolveBareModule } from "../frontend/resolve.js";
import type { IslandPackage } from "./boundary.js";
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
  /** The runtime fences the lowering reached (refusals deferred to the
   * operation that reaches them): the ones `fenceIslandsPackage` accepts
   * island their package. */
  fences?: readonly ScrDiagnostic[];
  /** The lowering failed and the build's explained retry has not run: when
   * no other rule grows the set, the compiled packages whose island class
   * is the runtime or a mutable object model run in Node for one retry.
   * Such a build typed those packages from their JavaScript, where the
   * types they only declare are `any`; the island build types the program
   * from their declarations. */
  explain?: boolean;
}

/** A package the fence rule moved into an island: how many reached
 * operations in it do not compile, and the first of them. */
export interface FencedPackage {
  count: number;
  first: ScrDiagnostic;
}

/** A grown island set. */
export interface GrownIslands {
  /** A copy of the set the round started from, with the growth added. */
  packages: Map<string, IslandPackage>;
  /** The packages the fence rule added, by name. */
  fenced: Map<string, FencedPackage>;
  /** The growth came from the explain rule alone: the caller retries with
   * it once and does not ask for it again. */
  explained: boolean;
}

/** The island set grown from what a lowering saw, or null when nothing
 * grows (`--node-islands=auto` only). `known` is the set the round started
 * from. */
export function growIslandSet(
  ctx: IslandGrowthContext,
  known: ReadonlyMap<string, IslandPackage>,
  growth: IslandGrowth,
): GrownIslands | null {
  if (ctx.policy.mode !== "auto") return null;
  const grown = new Map(known);
  const fenced = new Map<string, FencedPackage>();
  if (growth.preflight !== undefined && growth.preflight.length > 0)
    growFromPreflight(ctx, grown, growth.preflight);
  // Both rules run the ESM→CJS closure over the set as it stands, so they
  // run even when the lowering saw nothing (the closure grows an importer of
  // an island the set already holds).
  if (growth.diagnostics !== undefined) growFromLowering(ctx, grown, growth.diagnostics);
  if (growth.fences !== undefined)
    growFromFences(ctx, known, grown, growth.diagnostics ?? [], growth.fences, fenced);
  if (grown.size > known.size) return { packages: grown, fenced, explained: false };
  if (growth.explain !== true) return null;
  growFromClasses(ctx, known, grown, growth.diagnostics ?? [], growth.fences ?? []);
  return grown.size === known.size ? null : { packages: grown, fenced, explained: true };
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

/** The package an SC2013 names (a use of a package outside the compiled
 * module graph: an import() or require() the frontend did not compile):
 * that package runs in an island. False when the diagnostic names none the
 * rule can place. */
function growNamedPackage(
  ctx: IslandGrowthContext,
  grown: Map<string, IslandPackage>,
  d: ScrDiagnostic,
): boolean {
  const named = /npm package '([^']+)'/.exec(d.message);
  if (named === null) return false;
  const name = named[1]!;
  if (grown.has(name)) return true;
  if (ctx.policy.forcedNative.has(name) || ctx.policy.unloaded.has(name)) return false;
  const js =
    resolveBareModule(d.loc.file, name, "js-only") ??
    resolveBareModule(d.loc.file, name, "js-only", "require");
  const at = js === null ? null : packageDirOf(js.typesFile);
  if (at === null || at.name !== name) return false;
  grown.set(name, {
    name,
    version: packageVersionOf(at.dir),
    dir: at.dir,
    class: "packaging",
    reason: `${d.code}: ${d.message}`,
  });
  return true;
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
    if (d.code === "SC2013") {
      growNamedPackage(ctx, grown, d);
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

/** An explicit `--npm-static` request keeps its package native: the user
 * asked for its native compilation, deferred refusals included. */
function explicitlyStatic(explicit: readonly string[] | undefined): Set<string> {
  return new Set((explicit ?? []).map((name) => name.replace(/\.\.\.$/, "")));
}

/** Whether a reached runtime fence makes its package a Node island: a fence
 * in top-level module code, which throws when the module evaluates, or one
 * that itself needs the JavaScript runtime (R1; a use of a Node 24 global
 * native code does not provide excepted, since such a path is often one the
 * program never takes).
 *
 * This predicate is the staged part of the policy. Answering true for every
 * reached fence is the intended rule (no known refusal ships as a throw
 * unless the user names the package in `--npm-static`), and everything
 * around it already works that way: the island build is the build, and a
 * package that stays native with reached fences is reported (SC6006). It
 * waits for the island boundary: measured on 2026-11-07, running the fenced
 * packages of five small programs in Node fixed one (uuid), kept one
 * working (zod), broke the working path of one (commander: the island's
 * options object does not cross into the callback's record-typed
 * parameter), and moved two from the fence's throw to a run-time boundary
 * refusal a server adapter swallows (date-fns: a native Date; hono: a native
 * Request). */
function fenceIslandsPackage(d: ScrDiagnostic): boolean {
  if (d.moduleInit === true) return true;
  const reason = classifyDiagnostic(d, "fence");
  return reason.class === "runtime" && reason.reason !== "host-global";
}

/** The reached fences by natively compiled package, in the order the
 * lowering reported them. `explicit` names the packages the user asked to
 * keep native: their fences are theirs. */
function fencedPackages(
  npm: readonly NpmOutcome[],
  explicit: readonly string[] | undefined,
  policy: NodeIslandPolicy,
  fences: readonly ScrDiagnostic[],
): Map<string, FencedPackage & { islands: boolean }> {
  const compiled = compiledPackages(npm, explicitlyStatic(explicit));
  const fenced = new Map<string, FencedPackage & { islands: boolean }>();
  for (const d of fences) {
    const at = packageDirOf(d.loc.file);
    if (at === null || !compiled.has(at.name) || policy.unloaded.has(at.name)) continue;
    const islands = fenceIslandsPackage(d);
    const entry = fenced.get(at.name);
    if (entry === undefined) fenced.set(at.name, { count: 1, first: d, islands });
    else {
      entry.count++;
      // The fence that decides is the one the package is named for.
      if (islands && !entry.islands) {
        entry.islands = true;
        entry.first = d;
      }
    }
  }
  return fenced;
}

/** The packages compiled natively whose reached runtime fences make them
 * islands (`fenceIslandsPackage`). The island's class and reason are the
 * report's (the decisive class first), as its SC8001 note prints. */
function growFromFences(
  ctx: IslandGrowthContext,
  known: ReadonlyMap<string, IslandPackage>,
  grown: Map<string, IslandPackage>,
  diagnostics: readonly ScrDiagnostic[],
  fences: readonly ScrDiagnostic[],
  out: Map<string, FencedPackage>,
): void {
  if (fences.length === 0) return;
  const fenced = fencedPackages(ctx.npm, ctx.explicitNpmStatic, ctx.policy, fences);
  for (const [name, entry] of [...fenced])
    if (!entry.islands || known.has(name) || grown.has(name) || ctx.policy.forcedNative.has(name))
      fenced.delete(name);
  if (fenced.size > 0) {
    const report = buildNodeIslandReport({
      entry: ctx.entry,
      scan: ctx.scan,
      npm: ctx.npm,
      diagnostics,
      fences,
      policy: ctx.policy,
    });
    const reported = new Map(report.islands.map((island) => [island.package, island]));
    for (const [name, entry] of fenced) {
      const island = reported.get(name);
      const at = packageDirOf(entry.first.loc.file)!;
      const reason = classifyDiagnostic(entry.first, "fence");
      grown.set(
        name,
        island === undefined || island.path === null
          ? {
              name,
              version: packageVersionOf(at.dir),
              dir: at.dir,
              class: reason.class,
              reason: describe(reason),
            }
          : {
              name,
              version: island.version,
              dir: island.path,
              class: island.class,
              reason: island.reason,
            },
      );
      out.set(name, { count: entry.count, first: entry.first });
    }
  }
  growEsmImporters(
    ctx.policy,
    compiledPackages(ctx.npm, explicitlyStatic(ctx.explicitNpmStatic)),
    ctx.scan.edges,
    grown,
  );
}

/** The compiled packages whose island class explains a failed lowering:
 * the report gives them a runtime or object-model reason (a use of a
 * Node 24 global native code does not provide excepted: it never explains
 * a failure). */
function growFromClasses(
  ctx: IslandGrowthContext,
  known: ReadonlyMap<string, IslandPackage>,
  grown: Map<string, IslandPackage>,
  diagnostics: readonly ScrDiagnostic[],
  fences: readonly ScrDiagnostic[],
): void {
  const compiled = compiledPackages(ctx.npm, explicitlyStatic(ctx.explicitNpmStatic));
  const report = buildNodeIslandReport({
    entry: ctx.entry,
    scan: ctx.scan,
    npm: ctx.npm,
    diagnostics,
    fences,
    policy: ctx.policy,
  });
  for (const island of report.islands) {
    if (island.path === null) continue;
    if (!compiled.has(island.package) || known.has(island.package)) continue;
    if (ctx.policy.forcedNative.has(island.package) || ctx.policy.unloaded.has(island.package))
      continue;
    if (
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
  growEsmImporters(ctx.policy, compiled, ctx.scan.edges, grown);
}

/** A reached fence of `count` in a package, as a reason. */
function fenceReason(fence: FencedPackage): string {
  return `${fence.count === 1 ? "an operation" : `${fence.count} operations`} the program can reach ${fence.count === 1 ? "does" : "do"} not compile, first ${describe(classifyDiagnostic(fence.first, "fence"))}`;
}

/** The refusals of a build whose policy does not let a package run in Node
 * that the fence rule islands: a package marked native (SC8003), or any
 * natively compiled package while islands are limited to marked ones or off
 * (SC8002). Each names the fence that decides. Empty under the automatic
 * policy for every package it may island. */
export function fenceViolations(
  entry: string,
  policy: NodeIslandPolicy,
  npm: readonly NpmOutcome[],
  explicitNpmStatic: readonly string[] | undefined,
  npmImportSites: ReadonlyMap<string, SrcLoc>,
  fences: readonly ScrDiagnostic[],
): ScrDiagnostic[] {
  const out: ScrDiagnostic[] = [];
  for (const [name, fence] of fencedPackages(npm, explicitNpmStatic, policy, fences)) {
    if (!fence.islands) continue;
    const native = policy.forcedNative.has(name);
    if (!native && policy.mode === "auto") continue;
    if (!native && policy.forcedNode.has(name)) continue;
    const loc = npmImportSites.get(name) ?? { file: entry, start: 0, end: 0 };
    const why = fenceReason(fence);
    out.push(native ? nativePackageDiag(name, why, loc) : nodeIslandsOffDiag(name, why, loc));
  }
  return out;
}

/** The warnings of a build that keeps packages native with reached runtime
 * fences (SC6006, one per package): each such operation throws when the
 * program reaches it, where Node runs it. `islanded` holds the packages the
 * build runs in Node; a package named in `--npm-static` is not reported
 * (its fences were asked for), and a package the fence rule islands or
 * refuses is not one that stays native. */
export function deferredFenceWarnings(
  entry: string,
  policy: NodeIslandPolicy,
  npm: readonly NpmOutcome[],
  explicitNpmStatic: readonly string[] | undefined,
  npmImportSites: ReadonlyMap<string, SrcLoc>,
  fences: readonly ScrDiagnostic[],
  islanded: ReadonlyMap<string, IslandPackage>,
): ScrDiagnostic[] {
  const out: ScrDiagnostic[] = [];
  for (const [name, fence] of fencedPackages(npm, explicitNpmStatic, policy, fences)) {
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
