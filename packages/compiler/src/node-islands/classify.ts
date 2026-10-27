/* Diagnostic → Node island class (DESIGN.md §1.3). A refusal in a module
 * of an npm package is a reason for that package to run in a Node island;
 * its class says why: the runtime itself (R1), a mutable object model (R2),
 * a shipping problem (packaging), or a construct inside the native subset
 * that scriptc cannot compile yet (gap). The reason id on the diagnostic
 * (ScrDiagnostic.reason) decides first; the code and message decide for
 * refusal sites that do not carry one. */
import type { ScrDiagnostic } from "../diagnostics/diagnostic.js";
import type { NodeIslandMarker } from "./detect.js";
import { classOfRule, ruleInfo, ruleOfReason } from "./rules.js";
import type { RefusalRecord } from "./scan.js";
import type { NodeIslandReason, NodeIslandReasonSource } from "./summary.js";

/** Message shapes of refusal sites that predate reason ids. */
const MESSAGE_REASONS: { code: string; pattern: RegExp; reason: string }[] = [
  { code: "SC2010", pattern: /./, reason: "code-from-string" },
  { code: "SC1010", pattern: /'(?:node:)?vm'/, reason: "vm" },
  { code: "SC1090", pattern: /^dynamic import\(\) of computed/, reason: "dynamic-import" },
  { code: "SC1090", pattern: /require\(\) with a computed specifier/, reason: "dynamic-require" },
  { code: "SC1090", pattern: /'with' statement/, reason: "with" },
  { code: "SC1090", pattern: /sloppy-mode parameter aliases/, reason: "sloppy-arguments" },
  { code: "SC2020", pattern: /^'(?:eval|Function)'/, reason: "code-from-string" },
  {
    code: "SC2020",
    pattern: /createRequire's require with this argument shape/,
    reason: "dynamic-require",
  },
  { code: "SC2020", pattern: /native addon/, reason: "native-addon" },
  {
    code: "SC2020",
    pattern: /through require\.cache|require\.extensions|Module\._|module\.register/,
    reason: "loader-hook",
  },
  {
    code: "SC2020",
    pattern: /process\.binding|_linkedBinding|internalBinding|setFlagsFromString/,
    reason: "engine-internal",
  },
  { code: "SC2020", pattern: /\bWeakRef\b|\bFinalizationRegistry\b/, reason: "weak-ref" },
  { code: "SC1100", pattern: /\bWeakRef\b|\bFinalizationRegistry\b/, reason: "weak-ref" },
];

function reasonIdOf(d: ScrDiagnostic): string | null {
  if (d.reason !== undefined) return d.reason;
  for (const entry of MESSAGE_REASONS) {
    if (entry.code === d.code && entry.pattern.test(d.message)) return entry.reason;
  }
  return null;
}

/** Codes that are not reasons of the package they appear in: a cascade
 * marker repeats a root cause, an import of another refused package is
 * that package's island boundary, and divergences compile. */
export function isIslandReasonCode(code: string): boolean {
  if (code === "SC2004" || code === "SC2013") return false;
  if (/^SC6\d{3}$/.test(code)) return false;
  return true;
}

export function classifyDiagnostic(
  d: ScrDiagnostic,
  source: NodeIslandReasonSource,
): NodeIslandReason {
  const id = reasonIdOf(d);
  const rule = id === null ? null : ruleOfReason(id);
  if (rule !== null && id !== null) {
    return {
      class: classOfRule(rule),
      rule,
      reason: id,
      code: d.code,
      message: d.message,
      loc: d.loc,
      source,
    };
  }
  return {
    class: "gap",
    rule: null,
    reason: "gap",
    code: d.code,
    message: d.message,
    loc: d.loc,
    source,
  };
}

export function classifyMarker(m: NodeIslandMarker): NodeIslandReason {
  return {
    class: classOfRule(m.rule),
    rule: m.rule,
    reason: m.reason,
    code: null,
    message: `${ruleInfo(m.rule).title}: ${m.construct}`,
    loc: m.loc,
    source: "pre-scan",
  };
}

/** A refused package's status (pipeline.ts): the drop-and-reload record
 * when there is one, else the declaration and shipped-JS eligibility bar,
 * which is a packaging reason. */
export function classifyRefusal(
  detail: string,
  record: RefusalRecord | null,
): NodeIslandReason | null {
  if (record !== null && record.kind === "external") return null;
  if (record !== null && record.kind === "preflight" && record.diag !== null) {
    return classifyDiagnostic(record.diag, "package");
  }
  if (record !== null && record.kind === "offender" && /require|createRequire/.test(detail)) {
    return {
      class: "runtime",
      rule: "R1.2",
      reason: "dynamic-require",
      code: "SC2013",
      message: detail,
      loc: null,
      source: "package",
    };
  }
  return {
    class: "packaging",
    rule: null,
    reason: "packaging",
    code: "SC2013",
    message: detail,
    loc: null,
    source: "package",
  };
}
