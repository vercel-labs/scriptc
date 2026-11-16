// node:sqlite's serialize/deserialize: a database's bytes round-trip into a
// fresh connection, the dbName option selects the schema, the buffer checks
// answer Node's errors, and deserialize replaces the connection's database.
import { DatabaseSync } from "node:sqlite";

const source = new DatabaseSync(":memory:");
source.exec("CREATE TABLE t (a INTEGER, b TEXT); INSERT INTO t VALUES (1, 'x'), (2, 'y')");
const bytes = source.serialize();
console.log(bytes instanceof Uint8Array, bytes.length > 0);

const copy = new DatabaseSync(":memory:");
copy.deserialize(bytes);
console.log(copy.prepare("SELECT COUNT(*) AS n FROM t").get());
console.log(copy.prepare("SELECT a, b FROM t ORDER BY a").all());

const named = new DatabaseSync(":memory:");
named.deserialize(bytes, { dbName: "main" });
console.log(named.prepare("SELECT a FROM t ORDER BY a").all());
named.close();

// A connection's own database is replaced by the deserialized one.
const replace = new DatabaseSync(":memory:");
replace.exec("CREATE TABLE other (x)");
replace.deserialize(bytes);
console.log(replace.prepare("SELECT b FROM t ORDER BY a").all());
replace.close();

try {
  copy.deserialize(new Uint8Array(0));
} catch (error) {
  const e = error as { message: string; code: string };
  console.log("empty:", e.message, e.code);
}
try {
  copy.deserialize("nope" as unknown as Uint8Array);
} catch (error) {
  const e = error as { message: string; code: string };
  console.log("type:", e.message, e.code);
}
try {
  copy.deserialize(bytes, { dbName: 1 as any });
} catch (error) {
  const e = error as { message: string; code: string };
  console.log("dbname:", e.message, e.code);
}
console.log(copy.prepare("SELECT a FROM t ORDER BY a").all());
copy.close();
source.close();
