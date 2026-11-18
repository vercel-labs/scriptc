// node:sqlite's named parameters: `$name`/`@name`/`:name` keys and the bare
// names the option adds, unknown names (refused unless the option allows
// them), missing names (left NULL), and the conflict a statement whose
// parameters share a bare name raises.
import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync(":memory:");
db.exec("CREATE TABLE t (a, b)");
const insert = db.prepare("INSERT INTO t VALUES ($a, $b)");
console.log(insert.run({ a: 1, b: 2 }));
console.log(insert.run({ $a: 3, $b: 4 }));
try {
  insert.run({ a: 5, b: 6, c: 7 });
} catch (error) {
  const e = error as { message: string; code: string };
  console.log(e.message, e.code);
}
insert.setAllowUnknownNamedParameters(true);
console.log(insert.run({ a: 5, b: 6, c: 7 }));

const mixed = db.prepare("INSERT INTO t VALUES (:x, @y)");
mixed.setAllowBareNamedParameters(false);
try {
  mixed.run({ x: 1, y: 2 });
} catch (error) {
  const e = error as { message: string; code: string };
  console.log(e.message, e.code);
}
mixed.setAllowBareNamedParameters(true);
console.log(mixed.run({ x: 1, y: 2 }));
console.log(mixed.run({ x: 9 }));

// A statement whose parameters share a bare name cannot build the bare map.
const conflict = db.prepare("SELECT $v AS a, :v AS b");
try {
  conflict.get({ v: 1 });
} catch (error) {
  const e = error as { message: string; code: string };
  console.log(e.message, e.code);
}
console.log(db.prepare("SELECT * FROM t").all());

// A surplus anonymous parameter runs off the statement's parameter list.
try {
  db.prepare("SELECT ? AS q").get(1, 2);
} catch (error) {
  const e = error as { message: string; code: string; errcode: number };
  console.log(e.message, e.code, e.errcode);
}
// An unbound anonymous parameter reads as NULL.
console.log(db.prepare("SELECT ? AS q").get());
db.close();
