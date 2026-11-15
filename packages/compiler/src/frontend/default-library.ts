import type * as ts from "./ts7/adapter.js";
import { tsgoPath } from "./dts-paths.js";

/** A library file's directory and conventional name: TypeScript's own
 * `lib.*.d.ts` files, which the checker resolves from its bundled library
 * directory. A project file can carry the same name, so the name alone
 * never decides. */
const BUNDLED_LIBRARY_NAME = /^(.*)\/lib\.[^/]*\.d\.ts$/;

/** SCRIPTC_FRONTEND_LIBRARY_SCAN=full asks the checker about every library
 * file instead of once per library directory: the comparison the change was
 * measured against, kept for measurement. */
const fullScan = process.env["SCRIPTC_FRONTEND_LIBRARY_SCAN"] === "full";

/** Whether the program holds `fileName` as one of TypeScript's bundled
 * libraries. Whole-program scans ask this of every file — the fallback
 * declaration discovery, the child_process reachability check and the
 * supplied-file classification behind the reused library diagnostics — so
 * the answer is taken once per directory instead of once per file: the
 * default libraries of one program are one directory's `lib.*.d.ts` files,
 * and a directory whose first such file the checker marks as a default
 * library answers for the rest. */
export function isBundledLibraryFile(program: ts.Program, fileName: string): boolean {
  const match = BUNDLED_LIBRARY_NAME.exec(tsgoPath(fileName));
  if (match === null) return false;
  if (fullScan) return program.getSourceFileMetadata(fileName)?.isDefaultLibrary === true;
  const directory = match[1]!;
  const analysis = program.analysis;
  if (analysis.bundledLibraryDirectories.has(directory)) return true;
  if (analysis.checkedLibraryDirectories.has(directory)) return false;
  const metadata = program.getSourceFileMetadata(fileName);
  // A file the program does not hold answers nothing: ask again next time
  // rather than let one miss speak for the directory.
  if (metadata === undefined) return false;
  if (metadata.isDefaultLibrary !== true) {
    analysis.checkedLibraryDirectories.add(directory);
    return false;
  }
  analysis.bundledLibraryDirectories.add(directory);
  return true;
}
