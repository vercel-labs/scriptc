/* The island decision of a program, shared by a build (executable/
 * prepare.ts) and a coverage analysis (frontend/analysis.ts): which npm
 * packages and program modules run in Node islands on the first load, the
 * refusals a later load still has to place, and the inputs of the growth
 * rules (growth.ts) that add to the set from what each lowering saw. Both
 * callers run these functions in the same order, so a coverage report names
 * the islands a build of the same program runs. */
import { readFileSync, realpathSync } from "node:fs";
import {
  nodeIslandEntryPatchDiag,
  nodeIslandEntryReadDiag,
  nodeIslandImplicitGlobalReadDiag,
  nodeIslandModuleNoteDiag,
  nodeIslandNoteDiag,
  nodeIslandReaderStripDiag,
  nodeIslandStripDiag,
  nativePackageDiag,
  type ScrDiagnostic,
} from "../diagnostics/diagnostic.js";
import type { SrcLoc } from "../ir/ir.js";
import type { Frontend } from "../frontend/pipeline.js";
import type { NpmStaticStatus } from "../coverage/report.js";
import { readProjectConfig } from "../project-config.js";
import {
  isMarkedUserModule,
  nodeIslandPolicy,
  type NodeIslandOptions,
  type NodeIslandPolicy,
} from "./policy.js";
import { buildNodeIslandReport } from "./report.js";
import { nodeIslandSet } from "./boundary.js";
import type { IslandModule, IslandPackage, NodeIslandSet } from "./boundary.js";
import { classifyDiagnostic, classifyMarker, isIslandReasonCode } from "./classify.js";
import { packageDirOf, packageVersionOf } from "./origin.js";
import { describe } from "./summary.js";
import { resolveBareModule } from "../frontend/resolve.js";
import type { NodeIslandScan } from "./scan.js";
import type { IslandGrowthContext } from "./growth.js";
import type { NodeIslandMarker } from "./detect.js";
import { isJsSourceFileName } from "../frontend/tsc-codes.js";

/** What the decision reads from a build's or an analysis's options. */
export interface IslandDecisionOptions {
  nodeIslands?: NodeIslandOptions;
  npmStatic?: readonly string[] | "auto";
}

/** The packages an explicit `--npm-static` list names: the ones the user
 * asked to keep native. Undefined for the automatic selection. */
export function explicitNpmStatic(opts: IslandDecisionOptions): readonly string[] | undefined {
  const requested = opts.npmStatic;
  if (requested === undefined || typeof requested === "string") return undefined;
  return requested;
}

/** Whether two spellings name the same file (the checker resolves through
 * symlinks; a CLI argument may not). */
function sameFile(a: string, b: string): boolean {
  if (samePath(a, b)) return true;
  try {
    const real = realpathSync(a);
    const other = realpathSync(b);
    return samePath(real, other);
  } catch {
    return false;
  }
}

function samePath(a: string, b: string): boolean {
  return a.replaceAll("\\", "/") === b.replaceAll("\\", "/");
}

/** The pre-scan reasons that make a user module a sloppy-semantics island
 * by themselves (DESIGN.md note 1 §3.1): the constructs whose behavior
 * needs the JavaScript engine and that a syntax scan decides exactly, plus
 * the conservative `this` marker (decision S2). */
const SLOPPY_REASONS: ReadonlySet<string> = new Set([
  "with",
  "direct-eval",
  "annexb-block-function",
  "sloppy-this",
]);

/** A module that patches a builtin module's CommonJS object (the user's
 * decision, 2026-10-29): its patch is meant for code that shares Node's
 * builtin, so it runs in Node, where an island consumer sees it. */
const PATCH_REASONS: ReadonlySet<string> = new Set(["builtin-patch"]);

/** The program modules that run in Node islands, by file: modules marked
 * with `--node-island=<path>` or `scriptc.nodeIslands.modules`, and (under
 * `--node-islands=auto`) user JavaScript the pre-scan found a sloppy-only
 * construct in (decision S3). The entry stays native: a program whose entry
 * is an island runs the whole file in Node, which is a different feature. */
interface ModuleIslandDecision {
  modules: Map<string, IslandModule>;
  /** The entry module's own `builtin-patch` marker: the entry stays native
   * (a whole-file island is a different feature), so the build refuses it
   * with SC8006. */
  entryPatch: { file: string; marker: NodeIslandMarker } | null;
  /** User TypeScript modules with a `builtin-patch` marker that Node
   * cannot run with type stripping only (H3.5): SC8006, kept native. */
  stripProblems: { file: string; construct: string; loc: SrcLoc }[];
}

function moduleIslands(
  entryPath: string,
  policy: NodeIslandPolicy,
  scan: NodeIslandScan,
): ModuleIslandDecision {
  const modules = new Map<string, IslandModule>();
  let entryPatch: ModuleIslandDecision["entryPatch"] = null;
  const stripProblems: ModuleIslandDecision["stripProblems"] = [];
  for (const m of scan.modules) {
    if (m.origin !== "user") continue;
    const patches = m.markers.filter((marker) => PATCH_REASONS.has(marker.reason));
    // A TypeScript module islands only for a builtin patch (H3.2).
    if (!isJsSourceFileName(m.file) && patches.length === 0) continue;
    if (sameFile(m.file, entryPath)) {
      if (patches.length > 0 && entryPatch === null)
        entryPatch = { file: m.file, marker: patches[0]! };
      continue;
    }
    if (m.stripProblem !== null) {
      stripProblems.push({ file: m.file, ...m.stripProblem });
      continue;
    }
    const marked = isMarkedUserModule(policy, m.file);
    const sloppy = m.markers.filter((marker) => SLOPPY_REASONS.has(marker.reason));
    if (
      marked === null &&
      (policy.mode !== "auto" || (sloppy.length === 0 && patches.length === 0))
    )
      continue;
    const first = sloppy[0] ?? patches[0];
    const reason = first === undefined ? null : classifyMarker(first);
    modules.set(m.file, {
      file: m.file,
      class: reason === null ? "marked" : reason.class,
      reason:
        reason === null
          ? marked === "cli"
            ? "marked with --node-island"
            : 'marked "node" in scriptc.nodeIslands.modules'
          : describe(reason),
      decision: marked === null ? "auto" : "marked",
    });
  }
  return { modules, entryPatch, stripProblems };
}

/** The packages and modules a build runs in Node islands, or null for none:
 * under `--node-islands=auto` (the default) every npm package the native
 * pipeline refused plus the user modules the pre-scan found a sloppy
 * construct in, and packages marked `node`; under `explicit` only the
 * marked ones; under `off`, none (refusals stay SC2013). Each island is
 * reported once as an SC8001 note. */
export function decideNodeIslands(
  entryPath: string,
  opts: IslandDecisionOptions,
  fe: Frontend,
  lowerIslands: ReadonlyMap<string, IslandPackage>,
  lowerModules: ReadonlyMap<string, IslandModule>,
): (NodeIslandSet & { notes: ScrDiagnostic[]; errors: ScrDiagnostic[] }) | null {
  const policy = nodeIslandPolicy(readProjectConfig(entryPath), opts.nodeIslands);
  if (policy.mode === "off" || fe.nodeIslandScan === undefined) return null;
  // A package marked native stays refused: the build reports it rather
  // than running it in Node.
  const refused = new Set(
    policy.mode === "auto"
      ? fe.npmStatic
          .filter((e) => e.status === "refused" && !policy.forcedNative.has(e.package))
          .map((e) => e.package)
      : [],
  );
  for (const name of lowerIslands.keys()) refused.add(name);
  // The pre-scan's user-JavaScript markers exist only where a build may act
  // on them.
  const scan = fe.nodeIslandScan({ userJs: policy.mode === "auto" });
  const moduleDecision = moduleIslands(entryPath, policy, scan);
  const modules = moduleDecision.modules;
  // A sloppy write to an undeclared name creates a global — a sloppy-only
  // semantic the native tier does not implement, so the module runs in
  // Node (the user's policy, 2026-10-31). The checker decides this one, not
  // the syntax pre-scan: a write target needs bindings, and its sloppiness
  // depends on the enclosing function and file strictness. Preflight
  // reports it as SC1091 carrying the R2.4 reason. The entry stays native
  // (a whole-file island is a different feature), and a strict-mode write
  // is an ordinary lowering gap, so neither joins here.
  if (policy.mode === "auto") {
    for (const d of fe.preflight) {
      if (d.code !== "SC1091" || d.reason !== "implicit-global-write") continue;
      const file = d.loc.file;
      if (modules.has(file) || sameFile(file, entryPath)) continue;
      if (!isJsSourceFileName(file) || file.includes("/node_modules/")) continue;
      const reason = classifyDiagnostic(d, "refusal");
      modules.set(file, {
        file,
        class: reason.class,
        reason: describe(reason),
        decision: "auto",
      });
    }
  }
  // Modules the lowering refused keep their first reason (the reload no
  // longer compiles them).
  for (const [file, island] of lowerModules) if (!modules.has(file)) modules.set(file, island);
  const errors: ScrDiagnostic[] = [];
  if (moduleDecision.entryPatch !== null) {
    const { file, marker } = moduleDecision.entryPatch;
    errors.push(
      nodeIslandEntryPatchDiag(
        file,
        marker.member ?? marker.construct,
        builtinModuleOf(marker.member),
        marker.loc,
      ),
    );
  }
  for (const problem of moduleDecision.stripProblems)
    errors.push(nodeIslandStripDiag(problem.file, problem.construct, problem.loc));
  // Who else must see the patch (H3.4): every module that reads a patched
  // member through the builtin's CommonJS object joins the island set, npm
  // package or user module alike — the patch lives in the islands' Node, and
  // only sharing the builtin shows the read the patch, as in Node. The entry
  // stays native, and a user TypeScript module Node cannot strip cannot run
  // in Node at all: both are SC8006.
  const patchedMembers = new Map<string, string>();
  for (const m of scan.modules) {
    if (!modules.has(m.file)) continue;
    for (const marker of m.markers) {
      if (!PATCH_REASONS.has(marker.reason) || marker.member === undefined) continue;
      if (!patchedMembers.has(marker.member)) patchedMembers.set(marker.member, m.file);
    }
  }
  const readerPackages = new Map<
    string,
    { packageDir: string; member: string; patchFile: string }
  >();
  // A package the build marks native stays native: a read that only an
  // island could satisfy is SC8003, once per package and construct.
  const forcedNativeReads = new Set<string>();
  const readerModules = new Map<string, { member: string; patchFile: string }>();
  if (policy.mode === "auto" && patchedMembers.size > 0) {
    for (const m of scan.modules) {
      if (modules.has(m.file)) continue;
      for (const read of m.cjsReads) {
        const patchFile = patchFileOf(patchedMembers, read.member);
        if (patchFile === undefined) continue;
        if (m.origin === "npm" && m.packageName !== null && m.packageDir !== null) {
          if (policy.forcedNative.has(m.packageName)) {
            const key = `${m.packageName}:${read.member}`;
            if (!forcedNativeReads.has(key)) {
              forcedNativeReads.add(key);
              errors.push(
                nativePackageDiag(
                  m.packageName,
                  `it reads '${read.member}' through the CommonJS ${builtinModuleOf(read.member)} object, which island module ${patchFile} patches; a native read cannot see the patch`,
                  fe.npmImportSites.get(m.packageName) ?? read.loc,
                ),
              );
            }
            continue;
          }
          if (!readerPackages.has(m.packageName) && !refused.has(m.packageName))
            readerPackages.set(m.packageName, {
              packageDir: m.packageDir,
              member: read.member,
              patchFile,
            });
        } else if (m.origin === "user") {
          if (sameFile(m.file, entryPath)) {
            errors.push(
              nodeIslandEntryReadDiag(
                m.file,
                read.member,
                builtinModuleOf(read.member),
                patchFile,
                read.loc,
              ),
            );
            continue;
          }
          if (m.stripProblem !== null) {
            errors.push(
              nodeIslandReaderStripDiag(
                m.file,
                read.member,
                patchFile,
                m.stripProblem.construct,
                m.stripProblem.loc,
              ),
            );
            continue;
          }
          if (!readerModules.has(m.file))
            readerModules.set(m.file, { member: read.member, patchFile });
        }
      }
    }
  }
  // Who else must see an implicit global (H3.4): a sloppy write creates the
  // name on Node's global object when its island module runs, and native
  // code has no global object to read it from. An npm package that reads
  // the name joins the island set (its Node sees the global); a user module
  // or the entry is SC8020.
  const readerGlobals = new Map<
    string,
    { packageDir: string; global: string; writerFile: string }
  >();
  const createdGlobals =
    policy.mode === "auto" ? implicitGlobalWrites(fe, modules) : new Map<string, string>();
  if (createdGlobals.size > 0) {
    for (const m of scan.modules) {
      if (modules.has(m.file)) continue;
      for (const read of m.globalReads) {
        const writerFile = createdGlobals.get(read.name);
        if (writerFile === undefined) continue;
        if (m.origin === "npm" && m.packageName !== null && m.packageDir !== null) {
          if (policy.forcedNative.has(m.packageName)) {
            const key = `${m.packageName}:${read.name}`;
            if (!forcedNativeReads.has(key)) {
              forcedNativeReads.add(key);
              errors.push(
                nativePackageDiag(
                  m.packageName,
                  `it reads '${read.name}', which island module ${writerFile} creates as an implicit global; the native build has no global object, so the read cannot see it`,
                  fe.npmImportSites.get(m.packageName) ?? read.loc,
                ),
              );
            }
            continue;
          }
          if (!readerGlobals.has(m.packageName) && !refused.has(m.packageName))
            readerGlobals.set(m.packageName, {
              packageDir: m.packageDir,
              global: read.name,
              writerFile,
            });
        } else if (m.origin === "user") {
          errors.push(nodeIslandImplicitGlobalReadDiag(read.name, writerFile, read.loc));
        }
      }
    }
  }
  if (errors.length > 0) return { ...nodeIslandSet(new Map(), new Map()), notes: [], errors };
  // A user module that reads a patched member runs in a Node island, so its
  // read goes through the patched object exactly as in Node (H3.4).
  for (const [file, reader] of readerModules) {
    modules.set(file, {
      file,
      class: "object-model",
      reason: `it reads '${reader.member}' through the CommonJS ${builtinModuleOf(reader.member)} object, which island module ${reader.patchFile} patches`,
      decision: "auto",
    });
  }
  if (
    refused.size === 0 &&
    policy.forcedNode.size === 0 &&
    modules.size === 0 &&
    readerPackages.size === 0 &&
    readerGlobals.size === 0
  )
    return null;
  const report = buildNodeIslandReport({
    entry: entryPath,
    scan,
    npm: fe.npmStatic,
    diagnostics: [],
    fences: [],
    policy,
  });
  const packages = new Map<string, IslandPackage>();
  const notes: ScrDiagnostic[] = [];
  const seen = new Set<string>();
  for (const island of report.islands) {
    if (island.path === null) continue;
    seen.add(island.package);
    if (!refused.has(island.package) && !policy.forcedNode.has(island.package)) continue;
    packages.set(island.package, {
      name: island.package,
      version: island.version,
      dir: island.path,
      class: island.class,
      reason: island.reason,
    });
    notes.push(
      nodeIslandNoteDiag(
        island.package,
        island.version,
        island.class,
        island.reason,
        island.importedFrom[0] ??
          fe.npmImportSites.get(island.package) ?? { file: entryPath, start: 0, end: 0 },
      ),
    );
  }
  // Refused packages the report has no installed directory for (refused
  // before they joined the program): their directory from the runtime
  // entry Node resolves.
  for (const name of refused) {
    if (packages.has(name) || lowerIslands.has(name)) continue;
    const site = fe.npmImportSites.get(name) ?? { file: entryPath, start: 0, end: 0 };
    const dir = installedDirOf(site.file, name);
    if (dir === null) continue;
    const status = fe.npmStatic.find((e) => e.package === name);
    packages.set(name, {
      name,
      version: packageVersionOf(dir),
      dir,
      class: "packaging",
      reason: status?.detail ?? "its static compilation was refused",
    });
    notes.push(
      nodeIslandNoteDiag(name, packageVersionOf(dir), "packaging", status?.detail ?? "", site),
    );
  }
  // Packages islanded by their lowering refusals keep their first reason
  // (the reload no longer compiles them, so the scan has no reason).
  for (const [name, island] of lowerIslands) {
    if (seen.has(name) && packages.has(name)) {
      const kept = packages.get(name)!;
      if (kept.reason === "" || kept.class === "") packages.set(name, island);
      continue;
    }
    packages.set(name, island);
    notes.push(
      nodeIslandNoteDiag(
        island.name,
        island.version,
        island.class,
        island.reason,
        fe.npmImportSites.get(name) ?? { file: entryPath, start: 0, end: 0 },
      ),
    );
  }
  // npm packages that read a patched member join the island set: their
  // patch lives in the island's Node, and only a shared builtin shows it.
  for (const [name, reader] of readerPackages) {
    if (packages.has(name)) continue;
    const version = packageVersionOf(reader.packageDir);
    const reason = `it reads '${reader.member}' through the CommonJS ${builtinModuleOf(reader.member)} object, which island module ${reader.patchFile} patches`;
    packages.set(name, {
      name,
      version,
      dir: reader.packageDir,
      class: "object-model",
      reason,
    });
    notes.push(
      nodeIslandNoteDiag(
        name,
        version,
        "object-model",
        reason,
        fe.npmImportSites.get(name) ?? { file: entryPath, start: 0, end: 0 },
      ),
    );
  }
  // npm packages that read an implicit global an island module creates join
  // the island set: the global lives on their Node's global object.
  for (const [name, reader] of readerGlobals) {
    if (packages.has(name)) continue;
    const version = packageVersionOf(reader.packageDir);
    const reason = `it reads '${reader.global}', the implicit global island module ${reader.writerFile} creates`;
    packages.set(name, {
      name,
      version,
      dir: reader.packageDir,
      class: "object-model",
      reason,
    });
    notes.push(
      nodeIslandNoteDiag(
        name,
        version,
        "object-model",
        reason,
        fe.npmImportSites.get(name) ?? { file: entryPath, start: 0, end: 0 },
      ),
    );
  }
  for (const island of [...modules.values()].sort((a, b) =>
    a.file < b.file ? -1 : a.file > b.file ? 1 : 0,
  ))
    notes.push(
      nodeIslandModuleNoteDiag(island.file, island.class, island.reason, {
        file: island.file,
        start: 0,
        end: 0,
      }),
    );
  return packages.size === 0 && modules.size === 0
    ? null
    : { ...nodeIslandSet(packages, modules), notes, errors };
}

/** The installed package directory of `name` as Node resolves it from
 * `fromFile`, or null when there is none. `packageDirOf` reads the directory
 * off a file path, which answers only while that path names a node_modules
 * segment: a workspace-linked package's realpath elides the link, so its
 * directory is the resolution's own `workspaceDir` (the same answer the
 * checker's program registered the package under). */
function installedDirOf(fromFile: string, name: string): string | null {
  const js =
    resolveBareModule(fromFile, name, "js-only") ??
    resolveBareModule(fromFile, name, "js-only", "require");
  if (js === null) return null;
  return packageDirOf(js.typesFile)?.dir ?? js.workspaceDir ?? null;
}

/** Every package this pass binds to a Node island: the ones earlier rounds
 * decided (`lowerIslands`) plus this pass's decision. */
export function islandedPackages(
  lowerIslands: ReadonlyMap<string, IslandPackage>,
  decision: NodeIslandSet | null,
): Map<string, IslandPackage> {
  const all = new Map(lowerIslands);
  if (decision !== null) for (const [name, island] of decision.packages) all.set(name, island);
  return all;
}

/** The island set grown by refused packages no island binds yet, or null
 * when there are none. `decideNodeIslands` places the refusals it can see in
 * the detector's report and resolve from their import sites; a package
 * refused before it joined the type-checked program can be missing from
 * both. Under `--node-islands=auto` such a refusal is not fatal while the
 * package can run in Node: grow the island set and analyse the program once
 * more. Growth is monotone — an islanded package is never compiled
 * statically again — and a project has finitely many packages, so the retry
 * reaches a fixed point instead of looping. An explicit `--node-islands`
 * list or `off` keeps refusals fatal. */
export function refusalIslands(
  entryPath: string,
  opts: IslandDecisionOptions,
  fe: Frontend,
  refused: readonly NpmStaticStatus[],
  known: ReadonlyMap<string, IslandPackage>,
): Map<string, IslandPackage> | null {
  const policy = nodeIslandPolicy(readProjectConfig(entryPath), opts.nodeIslands);
  if (policy.mode !== "auto") return null;
  const grown = new Map(known);
  for (const entry of refused) {
    if (grown.has(entry.package)) continue;
    if (policy.forcedNative.has(entry.package) || policy.unloaded.has(entry.package)) continue;
    const site = fe.npmImportSites.get(entry.package) ?? { file: entryPath, start: 0, end: 0 };
    const dir = installedDirOf(site.file, entry.package);
    // A refusal whose directory cannot be resolved has nothing to island;
    // the fatal diagnostic keeps it visible.
    if (dir === null) continue;
    grown.set(entry.package, {
      name: entry.package,
      version: packageVersionOf(dir),
      dir,
      class: "packaging",
      reason: entry.detail ?? "its static compilation was refused",
    });
  }
  return grown.size === known.size ? null : grown;
}

/** The names the island modules' sloppy implicit-global writes create, each
 * with the file that creates it. Preflight reports each write as an SC1091
 * whose range is the write target. */
function implicitGlobalWrites(
  fe: Frontend,
  modules: ReadonlyMap<string, IslandModule>,
): Map<string, string> {
  const globals = new Map<string, string>();
  const sources = new Map<string, string>();
  for (const d of fe.preflight) {
    if (d.code !== "SC1091" || d.reason !== "implicit-global-write") continue;
    const file = d.loc.file;
    if (!modules.has(file)) continue;
    let source = sources.get(file);
    if (source === undefined) {
      source = readFileSync(file, "utf8");
      sources.set(file, source);
    }
    const name = source.slice(d.loc.start, d.loc.end);
    if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) && !globals.has(name)) globals.set(name, file);
  }
  return globals;
}

/** The builtin module a patched member belongs to ("fs" of
 * "fs.readFileSync"). */
function builtinModuleOf(member: string | undefined): string {
  if (member === undefined) return "";
  const end = /[.[]/.exec(member);
  return end === null ? member : member.slice(0, end.index);
}

/** The island module that patches `member`, matching an exact member or a
 * whole-module patch ("fs.*"). A read the scan cannot name ("fs.*", a
 * computed key or a rest element) matches every patch of its module, and so
 * does a patch through a computed key ("fs[…]"). */
function patchFileOf(patched: ReadonlyMap<string, string>, member: string): string | undefined {
  const module = builtinModuleOf(member);
  const exact = patched.get(member) ?? patched.get(`${module}.*`);
  if (exact !== undefined) return exact;
  const unnamedRead = member === `${module}.*`;
  for (const [patch, file] of patched) {
    if (builtinModuleOf(patch) !== module) continue;
    if (unnamedRead || patch.includes("[")) return file;
  }
  return undefined;
}

/** The growth inputs this build's frontend offers the shared island-growth
 * rules (node-islands/growth.ts), or null when the frontend holds no island
 * scan: the rules then grow nothing. `npmStatic` keeps a `"auto"` request
 * out: only an explicit list names the packages to keep native. */
export function islandGrowth(
  entryPath: string,
  opts: IslandDecisionOptions,
  fe: Frontend,
): IslandGrowthContext | null {
  const scan = fe.nodeIslandScan?.({ userJs: false });
  if (scan === undefined) return null;
  return {
    entry: entryPath,
    policy: nodeIslandPolicy(readProjectConfig(entryPath), opts.nodeIslands),
    scan,
    npm: fe.npmStatic,
    npmImportSites: fe.npmImportSites,
    ...(Array.isArray(opts.npmStatic) ? { explicitNpmStatic: opts.npmStatic } : {}),
    sourceTexts: () => fe.sourceTexts(),
  };
}

/** The island modules grown by the lowering's refusals in user JavaScript
 * (`--node-islands=auto` only), or null when there are none: a sloppy
 * module whose semantics the native pipeline refuses (an implicit global,
 * a mapped `arguments`, a `with` the pre-scan could not decide) runs in
 * Node. One retry adds every one of them at once. */
export function loweringModules(
  entryPath: string,
  opts: IslandDecisionOptions,
  diagnostics: readonly ScrDiagnostic[],
  known: ReadonlyMap<string, IslandModule>,
): Map<string, IslandModule> | null {
  const policy = nodeIslandPolicy(readProjectConfig(entryPath), opts.nodeIslands);
  if (policy.mode !== "auto" || known.size > 16) return null;
  const grown = new Map(known);
  for (const d of diagnostics) {
    if (!isIslandReasonCode(d.code)) continue;
    const file = d.loc.file;
    // Packages run in Node through their own decision
    // (node-islands/growth.ts).
    if (file.includes("/node_modules/") || packageDirOf(file) !== null) continue;
    if (!isJsSourceFileName(file) || sameFile(file, entryPath)) continue;
    if (grown.has(file)) continue;
    const reason = classifyDiagnostic(d, "refusal");
    // A gap is a construct scriptc does not implement, not a sloppy
    // semantic: running it in Node would hide a compiler limitation.
    if (reason.class === "gap") continue;
    grown.set(file, {
      file,
      class: reason.class,
      reason: describe(reason),
      decision: "auto",
    });
  }
  return grown.size === known.size ? null : grown;
}
