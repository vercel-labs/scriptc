import type { IrLibFn } from "./builtin-signatures.js";

/** Builtins decided never to throw: the runtime function behind the call
 * cannot raise an error and cannot run program code (a getter, `toJSON`,
 * `valueOf`, `toString`, a proxy trap or a callback), under any argument.
 *
 * Every builtin states its answer once: a row in MAY_THROW_LIB_FNS
 * (builtin-effects.ts) or a row here. A builtin in neither is compiled
 * without the check that delivers its error, so the error is lost and the
 * caller reads a placeholder result. The compiler does not read this set;
 * packages/compiler/test/builtin-attributes.test.ts holds every builtin to
 * the rule, and builtin-throw-undecided.txt lists the builtins that
 * predate it. */
export const NEVER_THROW_LIB_FNS: ReadonlySet<IrLibFn> = new Set<IrLibFn>([
  // scr_closure_adopt_identity writes two fields of the adapter.
  "closure.shareIdentity",
  // Emitted as the constant false; there is no runtime call.
  "sea.isSea",
  // scr_child_shell_line joins the file and the arguments into a new
  // string; its DEP0190 warning is queued for the next tick, where a
  // listener or process.throwDeprecation runs, not inside the call.
  "cp.shellLine",
  // scr_stream_stdio_readable returns the thread's stdin stream, creating
  // it on first use; nothing is read and no listener runs until the
  // stream flows.
  "stream.stdioReadable",
]);
