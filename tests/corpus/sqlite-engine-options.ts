// The vendored SQLite engine is the release Node 24.22.1 bundles, built with
// Node's `deps/sqlite/sqlite.gyp` defines: the version string and the
// compile_options list match Node's, except the row that names the C compiler
// (each build's own).
import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync(":memory:");
console.log(db.prepare("SELECT sqlite_version() AS version").get());
const rows = db.prepare("PRAGMA compile_options").all();
for (const row of rows) {
  const option = row.compile_options;
  if (typeof option === "string" && !option.startsWith("COMPILER=")) console.log(option);
}
db.close();
