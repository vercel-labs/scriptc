/** No initializer may hold the address of a thread-local.
 *
 * Every thread has its own copy of a `thread_local` global, at an address
 * that exists only while that thread runs, so the address is not a constant.
 * LLVM accepts `ptr @tls` in an initializer all the same and writes an
 * ordinary data relocation against the thread-local symbol. What that
 * relocation becomes depends on the link. GNU ld refuses it when the two
 * globals are in different objects ("TLS definition in a.o section .tdata
 * mismatches non-TLS reference in b.o"). lld links it, and the value is no
 * thread's copy: one program crashed before its first statement, another
 * ran and compared the pointer unequal to the thread's own. A large program
 * meets the refused link after its whole build and a small one the wrong
 * answer without a word, so the emitter refuses the text instead: an
 * initializer that needs such an address is a store each thread makes when
 * it starts (the module's stamps, emit-module.ts).
 *
 * The check reads the narrow grammar scriptc emits, like the splitter
 * (split.ts): a global definition starts a line with `@name = `, its
 * initializer may continue over the following lines while a bracket is
 * open, and string constants and comments name no symbol. */

import { InternalCompilerError } from "../../errors.js";

const AT = 64; // "@"
const NEWLINE = 10;
const QUOTE = 34;
const SEMICOLON = 59;

/** Whether `code` may be part of an unquoted symbol name. */
function isNameCode(code: number): boolean {
  return (
    (code >= 97 && code <= 122) ||
    (code >= 65 && code <= 90) ||
    (code >= 48 && code <= 57) ||
    code === 95 ||
    code === 46 ||
    code === 36 ||
    code === 45
  );
}

/** One of the words between a global's `=` and its `global` / `constant`:
 * linkage, visibility, `thread_local(model)`, `unnamed_addr`, …. */
const QUALIFIER = /^[a-z_]+(?:\([a-z0-9]*\))?$/;

/** The global definition or declaration that starts at `part[at]`, a `@`
 * at the start of a line: its name, the qualifier words before `global` /
 * `constant` (each followed by a space), and where its value type starts.
 * Null for any other form (an alias, a quoted name). */
function globalHead(
  part: string,
  at: number,
): { name: string; qualifiers: string; type: number } | null {
  let end = at + 1;
  while (isNameCode(part.charCodeAt(end))) end++;
  if (end === at + 1 || !part.startsWith(" = ", end)) return null;
  const words = end + 3;
  for (let word = words; ;) {
    const space = part.indexOf(" ", word);
    if (space < 0) return null;
    const text = part.slice(word, space);
    if (text === "global" || text === "constant")
      return {
        name: part.slice(at + 1, end),
        qualifiers: part.slice(words, word),
        type: space + 1,
      };
    if (!QUALIFIER.test(text)) return null;
    word = space + 1;
  }
}

/** Whether a line that starts at `part[at]` starts a top-level form, so no
 * initializer continues into it. */
function startsTopLevelForm(part: string, at: number): boolean {
  return (
    part.charCodeAt(at) === AT || part.startsWith("define ", at) || part.startsWith("declare ", at)
  );
}

/** Walks the global definitions and declarations of a module given as
 * `parts` joined by newlines. `head` sees each one's name and qualifier
 * words and answers whether its initializer is wanted; `reference` then
 * sees every symbol that initializer names. The walk ends at the first one
 * it answers true for, and returns it with the global whose initializer
 * names it. */
function walkGlobals(
  parts: readonly string[],
  head: (name: string, qualifiers: string) => boolean,
  reference: (name: string) => boolean,
): { holder: string; name: string } | null {
  // What an initializer is made of, as far as this walk reads it: a string
  // constant, a comment, a symbol, a bracket, the end of a line.
  const token = /"[^"]*"|;[^\n]*|@([-$._A-Za-z0-9]+)|[{}[\]()<>]|\n/g;
  // The definition whose initializer is being read, and its open brackets.
  // It can continue into the next part: a part ends where a line does.
  let holder: string | null = null;
  let depth = 0;
  for (const part of parts) {
    let at = 0;
    if (holder !== null && startsTopLevelForm(part, 0)) holder = null;
    while (at < part.length) {
      if (holder === null) {
        // The next line that starts with `@`; `at` is the start of a line.
        if (part.charCodeAt(at) !== AT) {
          const next = part.indexOf("\n@", at);
          if (next < 0) break;
          at = next + 1;
        }
        const found = globalHead(part, at);
        if (found === null || !head(found.name, found.qualifiers)) {
          // No initializer to read: on to the next line.
          const end = part.indexOf("\n", at);
          if (end < 0) break;
          at = end + 1;
          continue;
        }
        holder = found.name;
        depth = 0;
        at = found.type;
      }
      token.lastIndex = at;
      at = part.length;
      for (let m = token.exec(part); m !== null; m = token.exec(part)) {
        const code = part.charCodeAt(m.index);
        if (code === NEWLINE) {
          // The definition ends with its line unless a bracket is open.
          if (depth <= 0 || startsTopLevelForm(part, m.index + 1)) {
            holder = null;
            at = m.index + 1;
            break;
          }
        } else if (code === AT) {
          if (reference(m[1]!)) return { holder, name: m[1]! };
        } else if (code !== QUOTE && code !== SEMICOLON) {
          depth += code === 123 || code === 91 || code === 40 || code === 60 ? 1 : -1;
        }
      }
      if (at === part.length && depth <= 0) holder = null;
    }
  }
  return null;
}

/** The first initializer in the module `parts` (joined by newlines) that
 * names a thread-local global, or null. */
export function threadLocalAddressConstant(
  parts: readonly string[],
): { holder: string; threadLocal: string } | null {
  const threadLocals = new Set<string>();
  walkGlobals(
    parts,
    (name, qualifiers) => {
      if (qualifiers.includes("thread_local")) threadLocals.add(name);
      return false;
    },
    () => false,
  );
  if (threadLocals.size === 0) return null;
  const found = walkGlobals(
    parts,
    // A declaration has no initializer.
    (_, qualifiers) =>
      !qualifiers.startsWith("external ") && !qualifiers.startsWith("extern_weak "),
    (name) => threadLocals.has(name),
  );
  return found === null ? null : { holder: found.holder, threadLocal: found.name };
}

/** Refuses a module one of whose initializers holds a thread-local's
 * address. */
export function assertNoThreadLocalAddressConstant(parts: readonly string[]): void {
  const found = threadLocalAddressConstant(parts);
  if (found !== null)
    throw new InternalCompilerError(
      `llvm emitter bug: the initializer of @${found.holder} holds the address of @${found.threadLocal}, a thread-local: the address differs on every thread, so each thread has to store it when it starts`,
    );
}
