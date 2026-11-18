// node:sqlite's user-defined functions: argument lengths and varargs, the
// useBigIntArguments conversion, the values a function may answer (including
// NULL, BLOB and bigint), a JavaScript exception crossing back out unchanged,
// the arity SQLite registers, and aggregates (a value or function start, and
// a result function).
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

const db = new DatabaseSync(":memory:");
db.function("myadd", (a, b) => Number(a) + Number(b));
console.log(db.prepare("SELECT myadd(2, 3) AS sum").get());
db.function("up", { deterministic: true }, (s) => String(s).toUpperCase());
console.log(db.prepare("SELECT up('ab') AS u").get());
db.function("variadic", { varargs: true }, (...args) => args.length);
console.log(db.prepare("SELECT variadic(1, 2, 3) AS n").get());
db.function("argtypes", { useBigIntArguments: true }, (value) => typeof value);
console.log(db.prepare("SELECT argtypes(1) AS i, argtypes(1.5) AS f, argtypes('x') AS s").get());
db.function("nullish", () => null);
console.log(db.prepare("SELECT nullish() AS n").get());
db.function("blobby", () => new Uint8Array([1, 2]));
console.log(db.prepare("SELECT blobby() AS b").get());
db.function("big", () => 123n);
console.log(db.prepare("SELECT big() AS b").get());
db.function("bufferResult", () => {
  const buffer = new ArrayBuffer(2);
  new Uint8Array(buffer).set([9, 10]);
  return buffer as any;
});
console.log(db.prepare("SELECT bufferResult() AS b").get());

db.function("boom", () => {
  throw new Error("boom");
});
try {
  db.prepare("SELECT boom()").get();
} catch (error) {
  const e = error as Record<string, unknown>;
  console.log("boom:", e.message, e.code);
}
db.function("argcount", (first) => first);
try {
  db.prepare("SELECT argcount(1, 2)").get();
} catch (error) {
  const e = error as { message: string; code: string; errcode: number };
  console.log("arity:", e.message, e.code, e.errcode);
}
try {
  db.function("nofn", 1 as unknown as () => SQLInputValue);
} catch (error) {
  const e = error as { message: string; code: string };
  console.log("nofn:", e.message, e.code);
}

db.aggregate<number>("sumint", { start: 0, step: (acc, v) => acc + v });
console.log(
  db.prepare("WITH x(v) AS (VALUES (1), (2), (3)) SELECT sumint(v) AS total FROM x").get(),
);
db.aggregate<number>("startfn", { start: () => 10, step: (acc, v) => acc + v });
console.log(db.prepare("WITH x(v) AS (VALUES (1), (2)) SELECT startfn(v) AS total FROM x").get());
db.aggregate<number>("withresult", {
  start: 0,
  step: (acc, v) => acc + v,
  result: (acc) => acc * 2,
});
console.log(
  db.prepare("WITH x(v) AS (VALUES (1), (2)) SELECT withresult(v) AS total FROM x").get(),
);
try {
  db.aggregate<number>("badagg", { step: 1 as any });
} catch (error) {
  const e = error as { message: string; code: string };
  console.log("badagg:", e.message, e.code);
}
db.close();
