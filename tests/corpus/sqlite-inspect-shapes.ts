// util.inspect of node:sqlite's objects in a program that never names a
// symbol: DatabaseSync's Symbol(sqlite-type) brand still prints, the class
// accessors print as [Getter] (their values with getters: true), and a
// render that stops at the depth limit labels each object as Node does.
import { DatabaseSync } from "node:sqlite";
import { inspect } from "node:util";

const db = new DatabaseSync(":memory:");
const stmt = db.prepare("SELECT 1 AS a");
const tag = db.createTagStore(2);

console.log("db", inspect(db));
console.log("db-getters", inspect(db, { getters: true, depth: 0 }));
console.log("stmt-getters", inspect(stmt, { getters: true }));
console.log("nested", inspect({ db, stmt, tag, limits: db.limits }, { depth: 0 }));
console.log("tag", inspect(tag, { breakLength: 200 }));

db.close();
console.log("closed", inspect(db, { depth: 0 }));
