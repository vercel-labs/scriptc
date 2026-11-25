// The translation unit and defines of the vendored SQLite amalgamation
// (packages/runtime/vendor/sqlite, the copy Node v24.22.1 bundles in
// deps/sqlite), chosen the way Node's deps/sqlite/sqlite.gyp chooses them.
// packages/compiler/src/backend/vendor-inputs.ts keeps the same table for
// cross builds; a unit test checks that the two agree.

export const SQLITE_VERSION = "3.53.4";

/**
 * @param {string} _triple an LLVM or Zig target triple; the amalgamation
 *   builds the same way for every target (Node sets no per-target defines).
 * @returns {{ sources: string[], defines: string[], compileFlags: string[] }}
 */
export function sqliteInputs(_triple) {
  return {
    sources: ["sqlite3.c"],
    defines: [
      "SQLITE_DEFAULT_MEMSTATUS=0",
      "SQLITE_ENABLE_COLUMN_METADATA",
      "SQLITE_ENABLE_DBSTAT_VTAB",
      "SQLITE_ENABLE_FTS3",
      "SQLITE_ENABLE_FTS3_PARENTHESIS",
      "SQLITE_ENABLE_FTS5",
      "SQLITE_ENABLE_GEOPOLY",
      "SQLITE_ENABLE_MATH_FUNCTIONS",
      "SQLITE_ENABLE_PERCENTILE",
      "SQLITE_ENABLE_PREUPDATE_HOOK",
      "SQLITE_ENABLE_RBU",
      "SQLITE_ENABLE_RTREE",
      "SQLITE_ENABLE_SESSION",
    ],
    compileFlags: [],
  };
}
