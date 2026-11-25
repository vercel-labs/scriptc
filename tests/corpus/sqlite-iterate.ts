// node:sqlite's StatementSync.iterate(): one row per next(), { done: true,
// value: null } at the end, spread and for-of draining what is left, return()
// ending the iteration, and the invalidation another run of the statement
// brings.
import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync(":memory:");
db.exec("CREATE TABLE t (a); INSERT INTO t VALUES (1), (2), (3), (4)");
const select = db.prepare("SELECT a FROM t ORDER BY a");

const iterator = select.iterate();
console.log(iterator.next());
console.log(iterator.next());
console.log(iterator.next());
console.log(iterator.next());
console.log(iterator.next());
console.log(iterator.next());

const spread = select.iterate();
console.log([...spread]);
console.log([...spread]);

for (const row of select.iterate()) {
  if (row.a === 2) break;
  console.log(row);
}

const invalidated = select.iterate();
try {
  select.run();
  invalidated.next();
} catch (error) {
  const e = error as { message: string; code: string };
  console.log(e.message, e.code);
}

const ended = select.iterate();
ended.return();
console.log(ended.next());

const self = select.iterate();
console.log(self[Symbol.iterator]() === self);
select.close();
try {
  self.next();
} catch (error) {
  const e = error as { message: string; code: string };
  console.log(e.message, e.code);
}
db.close();
