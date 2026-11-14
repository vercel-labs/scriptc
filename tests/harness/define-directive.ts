import { programDefines as parseDefines } from "./define-directive.mjs";

/** `// @define: process.env.NAME="value"` lines in a corpus program's
 * directive head: scriptc builds the program with those `--define` values,
 * and the Node oracle runs with the variables set, the environment the
 * build fixes. Null when the head has none.
 *
 * The parser lives in `define-directive.mjs` so `scripts/tsan-workers.mjs`
 * can import it. This wrapper keeps the typed export the harness uses. */
export function programDefines(head: readonly string[]): {
  define: Record<string, string>;
  env: Record<string, string>;
} | null {
  return parseDefines(head);
}
