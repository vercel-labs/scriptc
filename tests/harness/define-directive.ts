/** `// @define: process.env.NAME="value"` lines in a corpus program's
 * directive head: scriptc builds the program with those `--define` values,
 * and the Node oracle runs with the variables set, the environment the
 * build fixes. Null when the head has none.
 *
 * The parser itself is plain JavaScript (define-directive.mjs) so the
 * ThreadSanitizer lane's script can import it without a TypeScript loader;
 * this module keeps the typed export the rest of the harness imports. */
// @ts-expect-error -- define-directive.mjs ships no declarations
import { programDefines as parseProgramDefines } from "./define-directive.mjs";

export function programDefines(head: readonly string[]): {
  define: Record<string, string>;
  env: Record<string, string>;
} | null {
  return parseProgramDefines(head) as {
    define: Record<string, string>;
    env: Record<string, string>;
  } | null;
}
