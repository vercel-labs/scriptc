// node:sqlite's DatabaseSync#limits: the live values each name reads, the
// writes that reach the connection (including Infinity resetting a limit to
// its compile-time maximum), the constructor's initial limits, and the
// errors a closed database answers.
import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync(":memory:");
const limits = db.limits;
console.log(limits.length, limits.sqlLength, limits.column, limits.variableNumber);
limits.length = 1000000;
console.log(limits.length, db.limits.length);
limits.length = Infinity;
console.log(limits.length);
try {
  limits.length = -1;
} catch (error) {
  const e = error as { message: string; code: string };
  console.log("neg:", e.message, e.code);
}
try {
  limits.length = "x" as unknown as number;
} catch (error) {
  const e = error as { message: string; code: string };
  console.log("str:", e.message, e.code);
}

const small = new DatabaseSync(":memory:", { limits: { variableNumber: 2 } });
console.log(small.limits.variableNumber);
try {
  small.prepare("SELECT ? AS a, ? AS b, ? AS c");
} catch (error) {
  const e = error as { message: string; code: string; errcode: number };
  console.log("bindlimit:", e.message, e.code, e.errcode);
}
small.close();
try {
  new DatabaseSync(":memory:", { limits: { variableNumber: -1 } });
} catch (error) {
  const e = error as { message: string; code: string };
  console.log("ctor:", e.message, e.code);
}
db.close();
try {
  console.log(limits.length);
} catch (error) {
  const e = error as { message: string; code: string };
  console.log("closed:", e.message, e.code);
}
