/* The Node island report's data model and the small helpers coverage
 * rendering needs. Kept free of compiler imports: the coverage report (and
 * the CLI's verdict-replay fast path behind it) loads this module. */
import type { ScrDiagnostic } from "../diagnostics/diagnostic.js";
import type { SrcLoc } from "../ir/ir.js";
import type { DecisionSource, NodeIslandPolicy } from "./policy.js";
import type { NodeIslandClass, NodeIslandRule } from "./rules.js";

export type NodeIslandReasonSource = "pre-scan" | "refusal" | "fence" | "package";

export interface NodeIslandReason {
  class: NodeIslandClass;
  rule: NodeIslandRule | null;
  /** Reason id: a rules.ts id, "gap" or "packaging". */
  reason: string;
  /** The SC code of the refusal, when the reason is a diagnostic. */
  code: string | null;
  message: string;
  loc: SrcLoc | null;
  source: NodeIslandReasonSource;
}

export type IslandDecision = "auto" | "config" | "cli";

export interface NodeIslandEntry {
  package: string;
  version: string | null;
  /** The package directory (the instance), when it is installed. */
  path: string | null;
  class: NodeIslandClass;
  /** The first decisive reason, rendered. */
  reason: string;
  /** The SC code of the first decisive reason, when it is a refusal. */
  diagnostic: string | null;
  decision: IslandDecision;
  /** Every reason, in report order (decisive class first, then source
   * order). */
  reasons: NodeIslandReason[];
  /** Modules of the package with at least one reason. */
  modules: number;
  /** Packages imported only through this island, which run inside it. */
  carries: string[];
  /** Where native code imports the package: the island boundary. */
  importedFrom: SrcLoc[];
  /** Report-only: deferral (NI-7) is not decided yet, so every island
   * would evaluate eagerly at its module position. */
  evaluation: "eager";
}

export interface UserModuleIsland {
  file: string;
  source: DecisionSource;
}

export interface NativePackage {
  package: string;
  version: string | null;
  path: string | null;
  /** "native": compiles natively; "inside": runs inside an island's
   * closure; "shared": reached from native code and from an island. */
  status: "native" | "inside" | "shared";
  /** For inside and shared: the islands that reach it. */
  islands: string[];
}

export interface NodeIslandReport {
  mode: "would-be";
  policy: NodeIslandPolicy["mode"];
  islands: NodeIslandEntry[];
  packages: NativePackage[];
  userModules: UserModuleIsland[];
  /** Would-be errors: SC8002 (islands off) and SC8003 (marked native). */
  violations: ScrDiagnostic[];
  /** SC8101–SC8105 for user JavaScript (only with --strict-user-js). */
  userJs: ScrDiagnostic[];
  /** --native / --node-island / config package names the program does
   * not import. */
  unknownPackages: string[];
}

/** "R2.1 constructor functions: 'new Foo()' of a function" or
 * "SC2012: <message>". */
export function describe(r: NodeIslandReason): string {
  if (r.source === "pre-scan" && r.rule !== null) return `${r.rule} ${r.message}`;
  const rule = r.rule === null ? "" : `${r.rule} `;
  return r.code === null ? `${rule}${r.message}` : `${rule}${r.code}: ${r.message}`;
}

/** True when the report has decisions to show (islands, marked modules,
 * policy errors or unknown names); SC81xx findings alone render as
 * blockers. */
export function hasNodeIslandDecisions(report: NodeIslandReport): boolean {
  return (
    report.islands.length > 0 ||
    report.userModules.length > 0 ||
    report.violations.length > 0 ||
    report.unknownPackages.length > 0
  );
}

/** True when the report has anything to show. */
export function hasNodeIslandFindings(report: NodeIslandReport): boolean {
  return (
    report.islands.length > 0 ||
    report.userModules.length > 0 ||
    report.violations.length > 0 ||
    report.userJs.length > 0 ||
    report.unknownPackages.length > 0
  );
}
