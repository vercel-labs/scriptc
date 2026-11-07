/* The Node island report: which packages and user modules run in a Node
 * island, and why (DESIGN.md §1.3–§1.7). With `decided` (a coverage
 * analysis), the islands are the ones the build's decision chose
 * (decide.ts and growth.ts), and the report explains them; without it (the
 * growth rules reading a package's class), every package with a reason is
 * listed.
 *
 *  1. Reasons per package instance: pre-scan markers in its modules,
 *     refusals and runtime fences the lowering produced in its modules, and
 *     the drop-and-reload refusal of a package that did not compile.
 *  2. Decision per package: the policy (forced node or native, the mode)
 *     applied to its reasons.
 *  3. Closure: a package imported only by island packages runs inside the
 *     island (it is Node's business); one reached from both sides is
 *     reported as shared (DESIGN.md §2.6 decides it later). */
import {
  nativePackageDiag,
  nodeIslandsOffDiag,
  nodeIslandsOffModuleDiag,
  userJsObjectModelDiag,
  type ScrDiagnostic,
} from "../diagnostics/diagnostic.js";
import type { SrcLoc } from "../ir/ir.js";
import {
  classifyDiagnostic,
  classifyMarker,
  classifyRefusal,
  isIslandReasonCode,
} from "./classify.js";
import {
  describe,
  type IslandDecision,
  type NativePackage,
  type NodeIslandEntry,
  type NodeIslandReason,
  type NodeIslandReasonSource,
  type NodeIslandReport,
  type UserModuleIsland,
} from "./summary.js";
import type { IslandModule, IslandPackage } from "./boundary.js";
import { packageDirOf, packageVersionOf } from "./origin.js";
import { isMarkedUserModule, type NodeIslandPolicy } from "./policy.js";
import { classRank, reportRank, ruleInfo, type NodeIslandClass } from "./rules.js";
import type { NodeIslandScan, RefusalRecord } from "./scan.js";

/** One dependency's native compilation outcome (coverage/report.ts's
 * NpmStaticStatus, restated to keep this module free of coverage). */
export interface NpmOutcome {
  package: string;
  status: "static" | "refused";
  detail?: string;
}

export interface NodeIslandReportInput {
  entry: string;
  scan: NodeIslandScan;
  npm: readonly NpmOutcome[];
  /** Lowering diagnostics of the analysis (reached and unreached), runtime
   * fences separately. */
  diagnostics: readonly ScrDiagnostic[];
  fences: readonly ScrDiagnostic[];
  policy: NodeIslandPolicy;
  /** The island set a build of the program runs (the decision of
   * decide.ts and growth.ts): the report names exactly these as islands,
   * with the build's class and reason, and leaves the policy's refusals to
   * the diagnostics the build fails with. */
  decided?: {
    packages: ReadonlyMap<string, IslandPackage>;
    modules: ReadonlyMap<string, IslandModule>;
  };
}

/** Reasons kept per package (the report renders the first per module). */
const REASON_CAP = 200;

interface PackageState {
  key: string;
  name: string;
  dir: string | null;
  reasons: NodeIslandReason[];
  importers: Set<string>;
  /** Every import site, with its importer ("" native user code,
   * "user:<file>" a marked user module, else a package key). */
  sites: { from: string; loc: SrcLoc }[];
  island: boolean;
  decision: IslandDecision;
  carriedBy: string | null;
  violation: boolean;
}

export function buildNodeIslandReport(input: NodeIslandReportInput): NodeIslandReport {
  const policy = input.policy;
  const states = new Map<string, PackageState>();
  const byName = new Map<string, string[]>();
  const state = (name: string, dir: string | null): PackageState => {
    const key = dir ?? `name:${name}`;
    let s = states.get(key);
    if (s === undefined) {
      s = {
        key,
        name,
        dir,
        reasons: [],
        importers: new Set<string>(),
        sites: [],
        island: false,
        decision: "auto",
        carriedBy: null,
        violation: false,
      };
      states.set(key, s);
      const keys = byName.get(name) ?? [];
      keys.push(key);
      byName.set(name, keys);
    }
    return s;
  };
  const addReason = (s: PackageState, r: NodeIslandReason): void => {
    if (s.reasons.length < REASON_CAP) s.reasons.push(r);
  };
  const ignored = (name: string): boolean => policy.unloaded.has(name);

  // Modules and their markers.
  for (const m of input.scan.modules) {
    if (m.origin !== "npm" || m.packageName === null) continue;
    if (ignored(m.packageName)) continue;
    const s = state(m.packageName, m.packageDir);
    for (const marker of m.markers) addReason(s, classifyMarker(marker));
  }
  // Import edges. A marked user module is an island owner of its own
  // (unless islands are off, where it is a violation and stays native).
  const USER = "user:";
  const userIsland = (file: string): boolean =>
    policy.mode !== "off" && isMarkedUserModule(policy, file) !== null;
  const imports = new Map<string, Set<string>>();
  for (const e of input.scan.edges) {
    if (e.shim || ignored(e.to)) continue;
    const s = state(e.to, e.toDir);
    const from = e.fromDir ?? (userIsland(e.fromFile) ? USER + e.fromFile : "");
    if (from === s.key) continue;
    s.importers.add(from);
    s.sites.push({ from, loc: e.loc });
    let out = imports.get(from);
    if (out === undefined) imports.set(from, (out = new Set<string>()));
    out.add(s.key);
  }
  // Lowering refusals and fences inside npm modules.
  const addDiagnostics = (diags: readonly ScrDiagnostic[], source: NodeIslandReasonSource) => {
    for (const d of diags) {
      if (!isIslandReasonCode(d.code)) continue;
      const at = packageDirOf(d.loc.file);
      if (at === null || ignored(at.name)) continue;
      addReason(state(at.name, at.dir), classifyDiagnostic(d, source));
    }
  };
  addDiagnostics(input.diagnostics, "refusal");
  addDiagnostics(input.fences, "fence");
  // Packages that did not compile.
  const records = new Map<string, RefusalRecord>();
  for (const r of input.scan.refusals) if (!records.has(r.package)) records.set(r.package, r);
  for (const outcome of input.npm) {
    if (outcome.status !== "refused" || ignored(outcome.package)) continue;
    const reason = classifyRefusal(
      outcome.detail ?? "its static compilation was refused",
      records.get(outcome.package) ?? null,
    );
    if (reason === null) continue;
    const keys = byName.get(outcome.package);
    if (keys === undefined || keys.length === 0) {
      addReason(state(outcome.package, null), reason);
      continue;
    }
    for (const key of keys) addReason(states.get(key)!, reason);
  }

  // Decisions.
  const violations: ScrDiagnostic[] = [];
  const fallbackLoc: SrcLoc = { file: input.entry, start: 0, end: 0 };
  const decided = input.decided;
  // The build's decision: its packages are the islands, whatever reasons
  // the report holds for the others (a package with reasons the build keeps
  // native is a native package).
  if (decided !== undefined) {
    for (const island of decided.packages.values()) {
      const target = state(island.name, island.dir);
      // Reasons recorded before the package had a directory (a refusal of a
      // package the program does not hold) belong to the island.
      const unplaced = states.get(`name:${island.name}`);
      if (unplaced !== undefined && unplaced !== target) {
        for (const r of unplaced.reasons) addReason(target, r);
        for (const from of unplaced.importers) target.importers.add(from);
        target.sites.push(...unplaced.sites);
        states.delete(unplaced.key);
      }
      target.island = true;
      target.decision = policy.forcedNode.get(island.name) ?? "auto";
    }
    for (const s of states.values()) sortReasons(s.reasons);
  }
  for (const s of decided === undefined ? states.values() : []) {
    sortReasons(s.reasons);
    const forcedNode = policy.forcedNode.get(s.name);
    const forcedNative = policy.forcedNative.get(s.name);
    const outside = s.reasons.length > 0;
    const loc = (s.sites.find((x) => x.from === "") ?? s.sites[0])?.loc ?? fallbackLoc;
    if (forcedNative !== undefined) {
      if (outside) {
        s.violation = true;
        violations.push(nativePackageDiag(s.name, describe(s.reasons[0]!), loc));
      }
      continue;
    }
    if (policy.mode === "off") {
      if (outside || forcedNode !== undefined) {
        s.violation = true;
        violations.push(
          nodeIslandsOffDiag(
            s.name,
            outside ? describe(s.reasons[0]!) : "it is marked to run in Node",
            loc,
          ),
        );
      }
      continue;
    }
    if (forcedNode !== undefined) {
      s.island = true;
      s.decision = forcedNode;
      continue;
    }
    if (!outside) continue;
    if (policy.mode === "explicit") {
      s.violation = true;
      violations.push(nodeIslandsOffDiag(s.name, describe(s.reasons[0]!), loc));
      continue;
    }
    s.island = true;
    s.decision = "auto";
  }

  // The island that owns an importer: a marked user module, an island
  // package, or the island a carried package runs inside; null for native.
  const ownerOf = (from: string): string | null => {
    if (from.startsWith(USER)) return from;
    const importer = states.get(from);
    return importer === undefined ? null : importer.island ? importer.key : importer.carriedBy;
  };
  const ownerName = (owner: string): string =>
    owner.startsWith(USER) ? owner.slice(USER.length) : states.get(owner)!.name;

  // Closure: packages imported only by islands (or by packages inside
  // them) run inside the island.
  for (let changed = true; changed;) {
    changed = false;
    for (const s of states.values()) {
      if (s.island || s.carriedBy !== null || s.violation) continue;
      if (s.importers.size === 0 || s.importers.has("")) continue;
      let carrier: string | null = null;
      let all = true;
      for (const from of s.importers) {
        const owner = ownerOf(from);
        if (owner === null) {
          all = false;
          break;
        }
        carrier ??= owner;
      }
      if (all && carrier !== null) {
        s.carriedBy = carrier;
        changed = true;
      }
    }
  }

  // Transitive reach: every non-island package an island loads, through
  // carried and shared packages alike (an island package is a boundary).
  const reach = new Map<string, Set<string>>();
  const owners = [...imports.keys()].filter(
    (k) => k.startsWith(USER) || states.get(k)?.island === true,
  );
  for (const owner of owners) {
    const name = ownerName(owner);
    const queue = [...(imports.get(owner) ?? new Set<string>())];
    const seen = new Set<string>(queue);
    while (queue.length > 0) {
      const key = queue.pop()!;
      if (states.get(key)?.island === true) continue;
      let names = reach.get(key);
      if (names === undefined) reach.set(key, (names = new Set<string>()));
      names.add(name);
      for (const next of imports.get(key) ?? new Set<string>()) {
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
  }

  // Entries.
  const islands: NodeIslandEntry[] = [];
  const packages: NativePackage[] = [];
  for (const s of states.values()) {
    const version = s.dir === null ? null : packageVersionOf(s.dir);
    if (s.island) {
      const first = s.reasons[0];
      const modules = new Set<string>();
      for (const r of s.reasons) if (r.loc !== null) modules.add(r.loc.file);
      const carries: string[] = [];
      for (const other of states.values()) {
        if (other.carriedBy === s.key) carries.push(other.name);
      }
      carries.sort();
      const built = decided?.packages.get(s.name);
      islands.push({
        package: s.name,
        version,
        path: s.dir,
        // The build's own class and reason (what its SC8001 note prints).
        class:
          built !== undefined && built.class !== ""
            ? (built.class as NodeIslandClass)
            : first === undefined
              ? "marked"
              : first.class,
        reason:
          built !== undefined && built.reason !== ""
            ? built.reason
            : first === undefined
              ? markedReason(s.decision)
              : describe(first),
        diagnostic: first === undefined ? null : first.code,
        decision: s.decision,
        reasons: s.reasons,
        modules: modules.size,
        carries,
        importedFrom: s.sites.filter((x) => ownerOf(x.from) === null).map((x) => x.loc),
        evaluation: "eager",
      });
      continue;
    }
    if (s.violation) continue;
    // A package that resolves to no installed JavaScript never loads (an
    // optional dependency that is absent): nothing to compile or island.
    if (s.dir === null && s.reasons.length === 0) continue;
    const reachingIslands = [...(reach.get(s.key) ?? new Set<string>())].sort();
    packages.push({
      package: s.name,
      version,
      path: s.dir,
      status: s.carriedBy !== null ? "inside" : reachingIslands.length > 0 ? "shared" : "native",
      islands: s.carriedBy !== null ? [ownerName(s.carriedBy)] : reachingIslands,
      ...(s.reasons.length > 0
        ? {
            outside: {
              class: s.reasons[0]!.class,
              reason: describe(s.reasons[0]!),
              reasons: s.reasons.length,
            },
          }
        : {}),
    });
  }
  islands.sort(
    (a, b) =>
      reportRank(a.class) - reportRank(b.class) ||
      compareText(a.package, b.package) ||
      compareText(a.path ?? "", b.path ?? ""),
  );
  packages.sort(
    (a, b) => compareText(a.package, b.package) || compareText(a.path ?? "", b.path ?? ""),
  );

  // Marked user modules and SC81xx in user JavaScript.
  const userModules: UserModuleIsland[] = [];
  const userJs: ScrDiagnostic[] = [];
  for (const m of input.scan.modules) {
    if (m.origin !== "user") continue;
    const marked = isMarkedUserModule(policy, m.file);
    if (decided !== undefined) {
      const module = decided.modules.get(m.file);
      if (module !== undefined) {
        userModules.push({
          file: m.file,
          source: module.decision === "auto" || marked === null ? "auto" : marked,
          reason: module.reason,
        });
        continue;
      }
    } else if (marked !== null && policy.mode !== "off") {
      userModules.push({ file: m.file, source: marked });
      continue;
    }
    if (marked !== null && decided === undefined) {
      violations.push(nodeIslandsOffModuleDiag(m.file, marked, { file: m.file, start: 0, end: 0 }));
    }
    if (!policy.strictUserJs) continue;
    for (const marker of m.markers) {
      const code = ruleInfo(marker.rule).userJsCode;
      if (code === null) continue;
      userJs.push(userJsObjectModelDiag(code, capitalize(marker.construct), marker.loc));
    }
  }
  userModules.sort((a, b) => compareText(a.file, b.file));

  const unknownPackages: string[] = [];
  // Only command-line names: a project's configuration may list packages
  // for other entries.
  for (const forced of [policy.forcedNode, policy.forcedNative]) {
    for (const [name, source] of forced) {
      if (source === "cli" && !byName.has(name) && !unknownPackages.includes(name))
        unknownPackages.push(name);
    }
  }
  unknownPackages.sort();

  return {
    mode: decided === undefined ? "would-be" : "build",
    policy: policy.mode,
    islands,
    packages,
    userModules,
    violations,
    userJs,
    unknownPackages,
  };
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function capitalize(text: string): string {
  return text.length === 0 ? text : text.charAt(0).toUpperCase() + text.slice(1);
}

function markedReason(decision: IslandDecision): string {
  return decision === "cli" ? "marked with --node-island" : 'marked "node" in scriptc.packages';
}

/** Decisive class first; within a class, refusals before pre-scan markers
 * (the lowering is authoritative), then source order. */
function sortReasons(reasons: NodeIslandReason[]): void {
  const sourceRank = (r: NodeIslandReason): number =>
    r.source === "package" ? 0 : r.source === "refusal" ? 1 : r.source === "fence" ? 2 : 3;
  reasons.sort(
    (a, b) =>
      classRank(a.class) - classRank(b.class) ||
      sourceRank(a) - sourceRank(b) ||
      compareText(a.loc?.file ?? "", b.loc?.file ?? "") ||
      (a.loc?.start ?? 0) - (b.loc?.start ?? 0),
  );
}
