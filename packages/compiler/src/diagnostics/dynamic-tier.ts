/* SC6101, the dynamic-tier performance warning: its text and how it prints.
 * All of the warning's wording is here. The functions it names come from
 * frontend/lowering/dynamic-tier.ts; this module only formats them, and it
 * imports nothing heavy so the CLI's routed cache hit can print a stored
 * warning without loading the compiler. */
import type { SrcLoc } from "../ir/ir.js";
import type { ScrDiagnostic } from "./diagnostic.js";

/** The code of the warning; SC61xx are performance notes, SC60xx divergences. */
export const DYNAMIC_TIER_CODE = "SC6101";

/** At most this many functions are named; the count covers all of them. */
export const DYNAMIC_TIER_SHOWN = 5;

/** Why a function counts as likely to run often. */
export type HotReason = "loop" | "called-in-loop" | "recursive";

const HOT_PHRASE: Record<HotReason, string> = {
  loop: "in a loop",
  "called-in-loop": "called in a loop",
  recursive: "recursive",
};

/** Why a function's values are untyped, as the warning words it. */
export type UntypedCause =
  | { kind: "any"; name: string }
  | { kind: "json-binding"; name: string }
  | { kind: "json" }
  | { kind: "javascript" }
  | {
      kind: "slot";
      name: string;
      declaredType: string;
      /** The declared type this is a dynamic piece of (push-down). */
      owner?: string;
    };

export function causePhrase(cause: UntypedCause): string {
  switch (cause.kind) {
    case "any":
      return `\`${cause.name}\` is \`any\``;
    case "json-binding":
      return `\`${cause.name}\` holds an untyped \`JSON.parse\` result`;
    case "json":
      return "untyped `JSON.parse` result";
    case "javascript":
      return "untyped JavaScript file";
    case "slot":
      return cause.owner === undefined
        ? `\`${cause.name}\` is a dynamic slot (declared \`${cause.declaredType}\`, which does not compile)`
        : `\`${cause.name}\` is a dynamic piece of \`${cause.owner}\` (declared \`${cause.declaredType}\`, which does not compile)`;
  }
}

export interface DynamicTierEntry {
  /** Display name (`advance`, `Parser.next`). */
  name: string;
  /** `file:line`, relative to the entry's directory. */
  where: string;
  cause: UntypedCause;
  hot: HotReason;
}

export interface DynamicTierPackageCount {
  name: string;
  functions: number;
}

/** The SC6101 diagnostic for likely-hot functions with untyped values, or
 * null when there are none. `loc` is the first function's declaration. */
export function dynamicTierDiag(
  entries: readonly DynamicTierEntry[],
  packages: readonly DynamicTierPackageCount[],
  loc: SrcLoc,
): ScrDiagnostic | null {
  const n = entries.length;
  if (n === 0) return null;
  const shown = entries.slice(0, DYNAMIC_TIER_SHOWN);
  const lines = [
    `${n} function${n === 1 ? "" : "s"} that likely run${n === 1 ? "s" : ""} often use${n === 1 ? "s" : ""} untyped values, which runs slower than typed code:`,
    ...shown.map((e) => `  ${e.name} (${e.where}): ${causePhrase(e.cause)}, ${HOT_PHRASE[e.hot]}`),
    ...(n > shown.length ? [`  and ${n - shown.length} more`] : []),
    ...(packages.length === 0
      ? []
      : [
          `  untyped code in npm packages: ${packages
            .map((p) => `${p.name} (${p.functions} function${p.functions === 1 ? "" : "s"})`)
            .join(", ")}`,
        ]),
  ];
  return {
    code: DYNAMIC_TIER_CODE,
    message: lines.join("\n"),
    loc,
    hint: "add types to compile these statically; see scriptc coverage --explain-dynamic",
  };
}

export function isPerformanceCode(code: string): boolean {
  return /^SC61\d{2}$/.test(code);
}

/** The warning as a build prints it: no source excerpt (it names several
 * functions), then its closing line. */
export function renderPerformanceWarnings(diags: readonly ScrDiagnostic[]): string {
  const blocks = diags.map(
    (d) => `warning ${d.code}: ${d.message}${d.hint === undefined ? "" : `\n  hint: ${d.hint}`}`,
  );
  const closing = diags.every((d) => d.code === "SC6104")
    ? "The program compiled. Declared types that compile keep these slots static."
    : "The program compiled. Adding types to these functions lets scriptc compile them to faster code.";
  return `${blocks.join("\n\n")}\n\n${closing}`;
}
