import { arrayOf, BOOL, DYN, STRING } from "../ir.js";
import { defineLibFnSignatures } from "./shared.js";

/** The path builtin call slots. */
export const pathSignatures = defineLibFnSignatures({
  /** node:path (scr_path.c ports BOTH of Node's implementations
   * function-by-function): the `path.*` family is posix, the
   * `path.win32*` family is Node v24's path.win32 ported exactly — the
   * frontend binds the bare module to the TARGET platform's family
   * (Node on Windows IS path.win32) and the path.posix / path.win32
   * namespaces to their own family everywhere. join and resolve take ONE
   * string[] arg — the frontend packs the variadic call's arguments into
   * an array literal. basename always receives its suffix (the frontend
   * completes an omitted one with "", a Node no-op). toNamespacedPath is
   * the posix identity and the win32 \\?\-prefixer. None of these throw;
   * the resolves consult the process cwd like Node's. */
  "path.join": { argTypes: [arrayOf(STRING)], result: STRING },
  "path.resolve": { argTypes: [arrayOf(STRING)], result: STRING },
  "path.normalize": { argTypes: [STRING], result: STRING },
  "path.dirname": { argTypes: [STRING], result: STRING },
  "path.basename": { argTypes: [STRING, STRING], result: STRING },
  "path.extname": { argTypes: [STRING], result: STRING },
  "path.isAbsolute": { argTypes: [STRING], result: BOOL },
  "path.relative": { argTypes: [STRING, STRING], result: STRING },
  "path.toNamespacedPath": { argTypes: [STRING], result: STRING },
  "path.win32Join": { argTypes: [arrayOf(STRING)], result: STRING },
  "path.win32Resolve": { argTypes: [arrayOf(STRING)], result: STRING },
  "path.win32Normalize": { argTypes: [STRING], result: STRING },
  "path.win32Dirname": { argTypes: [STRING], result: STRING },
  "path.win32Basename": { argTypes: [STRING, STRING], result: STRING },
  "path.win32Extname": { argTypes: [STRING], result: STRING },
  "path.win32IsAbsolute": { argTypes: [STRING], result: BOOL },
  "path.win32Relative": { argTypes: [STRING, STRING], result: STRING },
  "path.win32ToNamespacedPath": { argTypes: [STRING], result: STRING },
  /** path.parse: [root, dir, base, ext, name] as a fresh string[] (the
   * frontend builds the ParsedPath record); path.format: the pathObject's
   * root, dir, base, name and ext with undefined spelled "". */
  "path.parse": { argTypes: [STRING], result: arrayOf(STRING) },
  "path.win32Parse": { argTypes: [STRING], result: arrayOf(STRING) },
  "path.format": { argTypes: [STRING, STRING, STRING, STRING, STRING], result: STRING },
  "path.win32Format": { argTypes: [STRING, STRING, STRING, STRING, STRING], result: STRING },
  /** path.matchesGlob(path, pattern): Node's matchGlobPattern over its
   * bundled minimatch (scr_glob.c). Both families match case-insensitively
   * on macOS and Windows hosts like Node's; win32 also accepts either
   * separator. Throws TypeError for a pattern over 64 Ki code units,
   * RangeError for a brace sequence too long to expand, and SyntaxError
   * when a segment's regex is invalid under the u flag. */
  "path.matchesGlob": { argTypes: [STRING, STRING], result: BOOL },
  "path.win32MatchesGlob": { argTypes: [STRING, STRING], result: BOOL },
  "path.resolveValue": { argTypes: [DYN, BOOL], result: STRING },
  "path.parseValue": { argTypes: [DYN, BOOL], result: DYN },
  "path.formatValue": { argTypes: [DYN, BOOL], result: DYN },
  "path.toNamespacedValue": { argTypes: [DYN, BOOL], result: DYN },
});
