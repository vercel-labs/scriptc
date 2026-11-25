/* Strict mode's diagnostic policy.
 *
 * Strict mode turns the findings that measure distance from optimal code
 * into errors: a conversion that copies a record (SC6001), a performance
 * hint (the SC61xx family), and any Node island use (SC8001, added by the
 * caller from its island report). A line can opt out of one code with a
 * comment on that line:
 *
 *   const payload = JSON.parse(text); // scriptc-allow SC6101
 *
 * The comment names one or more four-digit codes (commas or spaces
 * separate them). It silences only that code at that line, and only under
 * strict mode: the ordinary warning output never consults it.
 */
import type { ScrDiagnostic } from "./diagnostic.js";
import type { SrcLoc } from "../ir/ir.js";
import { isPerformanceCode } from "./dynamic-tier.js";

/** Whether strict mode promotes `code` to an error. Node islands are added
 * by the caller, which has the island report and its import sites. */
export function isStrictCode(code: string): boolean {
  return code === "SC6001" || isPerformanceCode(code);
}

/** The text of the line `offset` is on. */
function lineAt(text: string, offset: number): string {
  const at = Math.max(0, Math.min(offset, text.length));
  const start = text.lastIndexOf("\n", at - 1) + 1;
  const end = text.indexOf("\n", at);
  return text.slice(start, end < 0 ? text.length : end);
}

/** The line's `//` comment, or null. String literals are skipped so a
 * message that spells the comment does not count. */
function lineComment(line: string): string | null {
  let quote = "";
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quote !== "") {
      if (ch === "\\") i++;
      else if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "/" && line[i + 1] === "/") return line.slice(i + 2);
  }
  return null;
}

/** The codes an allow comment on the line at `offset` names. */
export function allowedCodesAt(text: string, offset: number): Set<string> {
  const codes = new Set<string>();
  const body = lineComment(lineAt(text, offset));
  if (body === null) return codes;
  for (const match of body.matchAll(/scriptc-allow\b([^\n]*)/g)) {
    for (const code of (match[1] ?? "").matchAll(/SC\d{4}/g)) codes.add(code[0]);
  }
  return codes;
}

/** The strict error for a Node island the program uses. `loc` is the first
 * native import site, so a `// scriptc-allow SC8001` comment there opts the
 * island out. */
export function strictIslandError(
  loc: SrcLoc,
  names: readonly string[],
  detail?: string,
): ScrDiagnostic {
  const what = names.length === 0 ? "a package" : names.join(", ");
  return {
    code: "SC8001",
    severity: "error",
    message: `strict mode does not allow Node islands: ${what} runs in Node instead of compiling natively${detail === undefined ? "" : ` (${detail})`}`,
    loc,
    hint: "compile the package natively, mark it native, or remove the import; a // scriptc-allow SC8001 comment on this line opts the island out",
  };
}

/** The strict errors among `diagnostics`: promoted codes with no allow
 * comment on their line. */
export function strictErrors(
  diagnostics: readonly ScrDiagnostic[],
  sourceTexts: ReadonlyMap<string, string>,
): ScrDiagnostic[] {
  const errors: ScrDiagnostic[] = [];
  for (const diag of diagnostics) {
    if (!isStrictCode(diag.code) && diag.severity !== "error") continue;
    const text = sourceTexts.get(diag.loc.file);
    if (text !== undefined && allowedCodesAt(text, diag.loc.start).has(diag.code)) continue;
    errors.push({ ...diag, severity: "error" });
  }
  return errors;
}
