/* The refusal rules of scope B (results/design-scope-b/DESIGN.md §1.2):
 * the constructs that put a module outside the native subset, grouped in
 * eleven rule families, and the four classes the detector reports.
 *
 *   runtime       (R1) needs the JavaScript runtime itself
 *   object-model  (R2) needs a mutable object model
 *   gap           inside the native subset, but scriptc cannot compile it yet
 *   packaging     not compilable as shipped (no declarations, minified, ...)
 *
 * A reason id names one construct; refusal sites carry it on their
 * diagnostic (ScrDiagnostic.reason) and the pre-scan (detect.ts) reports it
 * with the rule. */

export type NodeIslandClass = "runtime" | "object-model" | "gap" | "packaging" | "marked";

export type NodeIslandRule =
  | "R1.1"
  | "R1.2"
  | "R1.3"
  | "R1.4"
  | "R1.5"
  | "R1.6"
  | "R2.1"
  | "R2.2"
  | "R2.3"
  | "R2.4"
  | "R2.5";

export interface RuleInfo {
  rule: NodeIslandRule;
  title: string;
  /** The SC81xx code the construct is in user JavaScript (R2 only). */
  userJsCode: "SC8101" | "SC8102" | "SC8103" | "SC8104" | "SC8105" | null;
}

const RULES: RuleInfo[] = [
  { rule: "R1.1", title: "code from strings", userJsCode: null },
  { rule: "R1.2", title: "dynamic module loading", userJsCode: null },
  { rule: "R1.3", title: "native addons", userJsCode: null },
  { rule: "R1.4", title: "loader and require hooks", userJsCode: null },
  { rule: "R1.5", title: "engine internals", userJsCode: null },
  { rule: "R1.6", title: "runtime-only globals", userJsCode: null },
  { rule: "R2.1", title: "constructor functions", userJsCode: "SC8101" },
  { rule: "R2.2", title: "prototype mutation", userJsCode: "SC8102" },
  { rule: "R2.3", title: "shape mutation outside the checker's view", userJsCode: "SC8103" },
  { rule: "R2.4", title: "sloppy-mode semantics", userJsCode: "SC8104" },
  { rule: "R2.5", title: "builtin and global patching", userJsCode: "SC8105" },
];

export function ruleInfo(rule: NodeIslandRule): RuleInfo {
  for (const info of RULES) if (info.rule === rule) return info;
  throw new Error(`unknown Node island rule ${rule}`);
}

/** Reason id → rule. Ids without a rule (gap, packaging) are absent. */
const REASON_RULES: Record<string, NodeIslandRule> = {
  "code-from-string": "R1.1",
  vm: "R1.1",
  "dynamic-require": "R1.2",
  "dynamic-import": "R1.2",
  "unresolved-import": "R1.2",
  "native-addon": "R1.3",
  "loader-hook": "R1.4",
  "engine-internal": "R1.5",
  "weak-ref": "R1.6",
  "constructor-function": "R2.1",
  "prototype-write": "R2.2",
  "define-property": "R2.3",
  with: "R2.4",
  "sloppy-arguments": "R2.4",
  "sloppy-mode": "R2.4",
  "builtin-write": "R2.5",
  proxy: "R2.5",
};

export function ruleOfReason(reason: string): NodeIslandRule | null {
  return REASON_RULES[reason] ?? null;
}

export function classOfRule(rule: NodeIslandRule): NodeIslandClass {
  return rule.startsWith("R1.") ? "runtime" : "object-model";
}

/** The decisive class first: a runtime need outranks an object-model need,
 * which outranks shipping problems; a gap is a package's class only when
 * nothing else keeps it out of the native subset (fixing the gap would make
 * it native). */
export function classRank(cls: NodeIslandClass): number {
  if (cls === "runtime") return 0;
  if (cls === "object-model") return 1;
  if (cls === "packaging") return 2;
  if (cls === "gap") return 3;
  return 4;
}

/** Report order: gap islands first (compiler work hidden behind an
 * island), then the rest by rank. */
export function reportRank(cls: NodeIslandClass): number {
  if (cls === "gap") return 0;
  return classRank(cls) + 1;
}

export function classDescription(cls: NodeIslandClass): string {
  if (cls === "runtime") return "needs the JavaScript runtime";
  if (cls === "object-model") return "needs a mutable object model";
  if (cls === "gap") return "inside the native subset, but scriptc cannot compile it yet";
  if (cls === "packaging") return "not compilable as shipped";
  return "marked to run in Node";
}
