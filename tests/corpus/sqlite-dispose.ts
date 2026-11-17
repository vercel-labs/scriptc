// node:sqlite's [Symbol.dispose]: a statement's dispose finalizes it (a later
// use is the finalized-statement error), and a database's dispose closes the
// connection, after which every use is the not-open error. Disposal is
// idempotent, so a second dispose after close is a no-op.
import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync(":memory:");
{
  using scope = db;
  const statement = db.prepare("SELECT 1 AS one");
  console.log(statement.get());
  {
    using inner = statement;
    console.log(inner.get());
  }
  try {
    statement.get();
  } catch (error) {
    const e = error as { message: string; code: string };
    console.log(e.message, e.code);
  }
  console.log(db.isOpen);
  db[Symbol.dispose]();
  console.log(db.isOpen);
}
try {
  db.exec("SELECT 1");
} catch (error) {
  const e = error as { message: string; code: string };
  console.log(e.message, e.code);
}
db[Symbol.dispose]();
console.log("disposed twice");
