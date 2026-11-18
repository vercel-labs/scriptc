// node:sqlite's DatabaseSync basics: an in-memory database opened by the
// constructor, a table created through exec(), inserts and reads through
// prepared statements (run/get/all), the connection's state getters, and
// the error a closed database answers.
import { DatabaseSync, StatementSync } from "node:sqlite";

const db = new DatabaseSync(":memory:");
console.log(db.isOpen, db.isTransaction, db.location());
db.exec("CREATE TABLE people (id INTEGER PRIMARY KEY, name TEXT NOT NULL, age INTEGER)");
const insert = db.prepare("INSERT INTO people (name, age) VALUES (?, ?)");
console.log(insert.run("Ada", 36));
console.log(insert.run("Grace", 85));
const select = db.prepare("SELECT * FROM people ORDER BY id");
console.log(db instanceof DatabaseSync, select instanceof StatementSync);
console.log(select.all());
console.log(select.get());
const byName = db.prepare("SELECT name, age FROM people WHERE name = ?");
console.log(byName.get("Ada"));
console.log(byName.get("nobody"));
console.log(db.prepare("SELECT COUNT(*) AS n FROM people").get());
db.exec("BEGIN");
console.log(db.isTransaction);
db.exec("COMMIT");
console.log(db.isTransaction);
db.close();
console.log(db.isOpen);
try {
  db.prepare("SELECT 1");
} catch (error) {
  const e = error as { message: string; code: string };
  console.log(e.message, e.code);
}
