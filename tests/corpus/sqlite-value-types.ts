// node:sqlite's JavaScript <-> SQLite conversions: integers (safe ones as
// numbers, larger ones only through readBigInts), reals, text, NULL and BLOB
// values coming back; number, string, boolean, bigint, bytes, null and
// object parameters going in.
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

const db = new DatabaseSync(":memory:");
const q = (sql: string) => db.prepare(sql).get();
console.log(q("SELECT 1 AS i, 2.5 AS f, 'hi' AS s, NULL AS n, x'01ff' AS b"));
try {
  q("SELECT 9223372036854775807 AS big");
} catch (error) {
  const e = error as { message: string; code: string };
  console.log("max:", e.message, e.code);
}
const big = db.prepare("SELECT 9007199254740993 AS big");
try {
  big.get();
} catch (error) {
  const e = error as { message: string; code: string };
  console.log("unsafe:", e.message, e.code);
}
big.setReadBigInts(true);
console.log(big.get());
console.log(q("SELECT 'héllo ☃' AS s"));
const blob = q("SELECT x'deadbeef' AS b")?.b as Uint8Array;
console.log(blob, blob.byteLength);

db.exec("CREATE TABLE v (x)");
const put = db.prepare("INSERT INTO v VALUES (?)");
// Boolean and symbol parameters are outside the declared input type but
// Node binds them (the boolean as 1/0, the symbol as a refusal).
console.log(
  put.run(true as unknown as SQLInputValue),
  put.run(1.25),
  put.run(123n),
  put.run(new Uint8Array([9, 8])),
  put.run(null),
);
console.log(db.prepare("SELECT typeof(x) AS t, x FROM v").all());
try {
  put.run(2n ** 70n);
} catch (error) {
  const e = error as { message: string; code: string };
  console.log("bigint:", e.message, e.code);
}
try {
  put.run(Symbol("x") as unknown as SQLInputValue);
} catch (error) {
  const e = error as { message: string; code: string };
  console.log("symbol:", e.message, e.code);
}
// A double-quoted string is a column name unless the option turns it on.
try {
  db.exec('SELECT "hi"');
} catch (error) {
  const e = error as { message: string; code: string; errcode: number; errstr: string };
  console.log("dqs:", e.message, e.code, e.errcode, e.errstr);
}
// ArrayBuffers bind their whole storage as a BLOB, like Node.
db.exec("CREATE TABLE bin (x)");
const bindBinary = db.prepare("INSERT INTO bin VALUES (?)");
const arrayBuffer = new ArrayBuffer(3);
new Uint8Array(arrayBuffer).set([4, 5, 6]);
const shared = new SharedArrayBuffer(2);
new Uint8Array(shared).set([7, 8]);
// The declared input type lists views only (as @types/node does); Node's
// runtime also takes whole ArrayBuffers, so the calls cast.
console.log(bindBinary.run(arrayBuffer as any), bindBinary.run(shared as any));
console.log(db.prepare("SELECT typeof(x) AS t, x FROM bin").all());

const dqs = new DatabaseSync(":memory:", { enableDoubleQuotedStringLiterals: true });
console.log(dqs.prepare('SELECT "hi" AS s').get());
dqs.close();
db.close();
