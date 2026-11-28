const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(":memory:");
db.cache = db.prepare("SELECT 1 AS n");
console.log("before", db.cache.get().n);
db.close();
console.log("closed", db.isOpen);
try {
  db.cache.get();
} catch (e) {
  console.log("use", e.message);
}
for (let i = 0; i < 3; i++) {
  const loop = new DatabaseSync(":memory:");
  loop.cache = loop.prepare("SELECT " + i + " AS n");
  loop.close();
}
console.log("done");
