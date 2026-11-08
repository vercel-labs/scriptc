/* Which runtimeFence statements stand for a diagnostic the compiler deferred.
 *
 * A JavaScript statement that does not compile becomes a throw of its
 * diagnostic at the operation that reaches it, and the lowering renders the
 * thrown message so that it names that diagnostic: the message ends with the
 * diagnostic's tag, "[SC2020 at <file>:<line>]", or "[SC2020]" where the
 * site has no position. These are the sites a coverage report lists as
 * deferred. The other runtimeFence statements are traps and refusals the
 * lowering writes itself (the unreachable-fallthrough trap, a refusal on one
 * arm of a dynamic dispatch); their messages carry no tag.
 *
 * The backend reports a deferred diagnostic on stderr the first time its
 * site fires (scr_deferred_fence.c), so a handler that catches the Error
 * cannot hide a refusal the compiler knew about. Only fences in JavaScript
 * sources report. A TypeScript source's constructs are compile errors, and
 * the fences it can still hold (a typed-array store through an index that
 * is undefined at run time, a builtin function value with no lowering) keep
 * the plain throw, so a typed program, the compiler's own source included,
 * compiles to what it did. */

import type { IrModule, IrStmt, SrcLoc } from "./ir.js";
import { everyModuleNode, everyStmtList } from "./traverse.js";

/** Whether a runtimeFence at `file` with this code and message stands for
 * a deferred diagnostic that reports: `message` ends with the tag of
 * `code`, and `file` is a JavaScript source. */
export function isDeferredDiagnosticFence(code: string, message: string, file: string): boolean {
  if (!/\.[cm]?jsx?$/.test(file)) return false;
  if (!message.endsWith("]")) return false;
  const tag = message.lastIndexOf(`[${code}`);
  if (tag < 0) return false;
  const rest = message.slice(tag + code.length + 1, -1);
  return rest === "" || rest.startsWith(" at ");
}

/* A deferred diagnostic inside its own `try`.
 *
 * `try { optional() } catch { … }` is how a JavaScript program asks for
 * something that may not be there. When the statement in the `try` block is
 * one the compiler deferred, the program's `catch` runs, also where Node's
 * would not, and the program's own handler deals with it: its output may be the
 * same as under Node (the handler ignores the failure) or differ (the handler
 * takes another path). Reporting the site on stderr at every run would make
 * the first kind of program differ from Node where it otherwise does not, so
 * such a site is named at build time instead (SC6012, one warning per site),
 * and the run reports it only under SCRIPTC_DEFERRED_REPORT=all.
 *
 * "Its own" is lexical and per function: the fence is a statement of the
 * `try` block of a `try` statement that has a `catch` clause, in the same
 * function body (through any nesting of blocks, loops and inner `try`
 * statements). A fence in a function that the block calls is not guarded,
 * nor is one in a `try` with only a `finally`, in a `catch` block or in a
 * `finally` block: those report at run time as before. */

/** Marks the deferred-diagnostic fences among `tryBody`, the lowered `try`
 * block of a source `try` statement that has a `catch` clause. Functions the
 * block declares are lowered apart from it, so the walk stays in the
 * function that contains the `try`. */
export function markGuardedDeferredFences(tryBody: IrStmt[]): void {
  everyStmtList(tryBody, {
    expr: () => true,
    stmt: (node) => {
      if (
        node.kind === "runtimeFence" &&
        isDeferredDiagnosticFence(node.code, node.message, node.loc.file)
      )
        node.guarded = true;
      return true;
    },
  });
}

/** One guarded deferred-diagnostic site of a module: the refusal as the
 * fence throws it (without its tag), its code, and the statement. */
export interface GuardedDeferredFence {
  code: string;
  refusal: string;
  loc: SrcLoc;
}

/** The guarded deferred-diagnostic fences of `mod`, one per site (a site is
 * its message, as in the runtime's report), in the order the module holds
 * them. A library reports nothing at run time for any fence, so it has
 * none. */
export function guardedDeferredFences(mod: IrModule): GuardedDeferredFence[] {
  if (mod.lib !== undefined) return [];
  const sites = new Map<string, GuardedDeferredFence>();
  everyModuleNode(mod, {
    expr: () => true,
    stmt: (node) => {
      if (node.kind === "runtimeFence" && node.guarded === true && !sites.has(node.message)) {
        const tag = node.message.lastIndexOf(`[${node.code}`);
        sites.set(node.message, {
          code: node.code,
          refusal: (tag < 0 ? node.message : node.message.slice(0, tag)).trimEnd(),
          loc: node.loc,
        });
      }
      return true;
    },
    type: () => true,
  });
  return [...sites.values()];
}
