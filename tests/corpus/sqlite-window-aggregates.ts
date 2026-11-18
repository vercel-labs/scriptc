// node:sqlite's window aggregates: as a row leaves the frame SQLite calls the
// inverse callback (which subtracts the row's contribution), the unbounded
// frame only steps, and the result callback shapes each frame's value.
import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync(":memory:");
db.exec("CREATE TABLE w (x)");
db.exec("INSERT INTO w VALUES (1), (2), (3), (4)");
db.aggregate<number>("sumwin", {
  start: 0,
  step: (acc, value) => acc + value,
  inverse: (acc, value) => acc - value,
});
console.log(
  db
    .prepare(
      "SELECT x, sumwin(x) OVER (ORDER BY x ROWS BETWEEN 1 PRECEDING AND CURRENT ROW) AS s " +
        "FROM w ORDER BY x",
    )
    .all(),
);
console.log(
  db
    .prepare(
      "SELECT x, sumwin(x) OVER (ORDER BY x ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS s " +
        "FROM w ORDER BY x",
    )
    .all(),
);
db.aggregate<number>("countwin", {
  start: 0,
  step: (acc) => acc + 1,
  inverse: (acc) => acc - 1,
  result: (acc) => acc * 10,
});
console.log(
  db
    .prepare(
      "SELECT countwin() OVER (ORDER BY x ROWS BETWEEN 1 PRECEDING AND CURRENT ROW) AS c " +
        "FROM w ORDER BY x",
    )
    .all(),
);
db.close();
