// node:sqlite through every import spelling: a renamed named import, a
// namespace import, and the member read on a namespace object. The lowering
// resolves a sqlite member from the name the access spells, so each of these
// must still reach the same runtime calls.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync as DB, backup as snap } from "node:sqlite";
import * as sqlite from "node:sqlite";

const dir = mkdtempSync(join(tmpdir(), "scriptc-sqlite-aliased-"));
try {
  const source = new DB(join(dir, "source.db"));
  source.exec("create table t(x)");
  source.exec("insert into t values (1), (2)");
  const pages = await snap(source, join(dir, "copy.db"));
  console.log("backup", pages, source instanceof DB, source instanceof sqlite.DatabaseSync);

  const other = new sqlite.DatabaseSync(join(dir, "other.db"));
  other.exec("create table t(x)");
  other.exec("insert into t values (3)");
  console.log("namespace", other.prepare("select count(*) as n from t").get(), other instanceof DB);

  source.close();
  other.close();
} finally {
  rmSync(dir, { recursive: true, force: true });
}
