// Non-strict CommonJS ignores an assignment to a getter-only SQLite
// property, as Node does: isOpen and sourceSQL keep their values and gain no
// own property. A strict function in the same file still throws for a
// property only it writes.
const { DatabaseSync } = require("node:sqlite");

const db = new DatabaseSync(":memory:");
const stmt = db.prepare("SELECT 1 AS a");

db.isOpen = false;
stmt.sourceSQL = 1;
console.log("sloppy", db.isOpen, stmt.sourceSQL, Object.keys(db).length);

function strictAssign() {
  "use strict";
  try {
    db.isTransaction = true;
    console.log("strict none");
  } catch (error) {
    console.log("strict", error.name, error.message);
  }
}
strictAssign();

db.added = 4;
console.log("added", db.added, Object.keys(db).join(","));
