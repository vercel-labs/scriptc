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
