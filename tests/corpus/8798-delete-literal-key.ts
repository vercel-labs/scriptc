// `delete r[key]` names the same field a dot access names when `key` is a
// binding of one string-literal type (a `const`, a literal-typed
// parameter): the key folds like a keyed record read/write folds it, so an
// optional field takes its ABSENT state instead of the "required field"
// fence. A pure `Record<string, T>` deletes through the overflow map, and
// process.env unsets, exactly as their dot forms do.
interface Row {
  first?: number;
  second?: number;
  third?: number;
}
const row: Row = { first: 1, second: 2, third: 3 };

const firstKey = "first";
delete row[firstKey];
console.log("first" in row, row.first, Object.keys(row).length);

const secondKey = "second" as const;
function dropSecond(): void {
  delete row[secondKey];
}
dropSecond();
console.log("second" in row, row.second, Object.keys(row).join(","));

// A literal-typed parameter folds too.
function dropThird(key: "third"): void {
  delete row[key];
}
dropThird("third");
console.log("third" in row, row.third, JSON.stringify(row));

const counts: Record<string, number> = { a: 1, b: 2 };
const countKey = "a";
delete counts[countKey];
console.log("a" in counts, counts.a, Object.keys(counts).join(","));

const envName = "SCRIPTC_TEST_ENV";
delete process.env[envName];
console.log("env", process.env.SCRIPTC_TEST_ENV === undefined);
