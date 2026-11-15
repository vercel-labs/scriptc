/* Where the compiler was when it failed by itself.
 *
 * Two failures are the compiler's own and not the program's: a broken
 * invariant (InternalCompilerError) and a panic inside the TypeScript
 * checker (a thrown Error whose message starts "panic:"). Both are thrown
 * from arbitrary depth, and a diagnostic for one is only useful when it
 * names the source it was working on: "internal compiler error" at line 1
 * of the entry says nothing about a program of a thousand files.
 *
 * The lowering frames that know a node (an expression, a statement, a
 * declaration being collected) note it here as the error passes them on
 * its way out. The innermost frame is the first to see the error, and the
 * first note for an error stands. Whichever fence finally turns the error
 * into a diagnostic asks for the site and falls back to its own node. */
import { InternalCompilerError } from "../errors.js";
import type { SrcLoc } from "../ir/ir.js";
import { checkerPanicDiag, iceDiag, isCheckerPanic, type ScrDiagnostic } from "./diagnostic.js";

/** The error noted last and the innermost node it interrupted. One slot
 * is enough: one error propagates at a time, and a newer one replaces it. */
let noted: { error: Error; loc: SrcLoc } | null = null;

/** True for an internal compiler error and for a checker panic. */
export function isCompilerCrash(e: unknown): e is Error {
  return e instanceof InternalCompilerError || isCheckerPanic(e);
}

/** Notes the site of `error` unless a frame nearer the throw already
 * named one. The site is asked for only then, and a node with no position
 * (one the lowering made up) names none: the crash keeps the next frame's. */
export function noteCrashSite(error: Error, site: () => SrcLoc): void {
  if (noted !== null && noted.error === error) return;
  let loc: SrcLoc;
  try {
    loc = site();
  } catch {
    return;
  }
  noted = { error, loc };
}

/** The innermost site noted for `error`, or null when no frame that knows
 * a node saw it. */
export function crashSiteOf(error: unknown): SrcLoc | null {
  return noted !== null && noted.error === error ? noted.loc : null;
}

/** The diagnostic for a compiler crash: SC9001 for a broken invariant,
 * SC0004 for a checker panic, at the innermost site noted for it, else at
 * `fallback`. The diagnostic replaces the raw exception a crash used to
 * end the process with; SCRIPTC_CRASH_STACK=1 prints the exception's
 * stack beside it, for whoever debugs the compiler. */
export function compilerCrashDiag(error: Error, fallback: SrcLoc): ScrDiagnostic {
  const loc = crashSiteOf(error) ?? fallback;
  if (process.env["SCRIPTC_CRASH_STACK"] === "1" && error.stack !== undefined)
    process.stderr.write(`${error.stack}\n`);
  const detail = error.message.split("\n", 1)[0]!;
  return isCheckerPanic(error) ? checkerPanicDiag(detail, loc) : iceDiag(detail, loc);
}
