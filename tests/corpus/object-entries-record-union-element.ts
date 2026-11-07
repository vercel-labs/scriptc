// Object.keys/entries over elements of a union-of-records array and over a
// union whose arms also include a unit: an indexed read carries the
// unchecked-index `undefined` in the lowered union, so each in-range
// element's runtime tag picks its own arm's static walk, and a unit value
// is Node's TypeError ("Cannot convert undefined or null to object")
// rather than a compile-time refusal.
type A = { a: string; b: string };
type B = { c: string };

const rows: (A | B)[] = [{ a: "one", b: "two" }, { c: "three" }, { a: "four", b: "five" }];

for (let i = 0; i < rows.length; i++) {
  const row = rows[i];
  if (row !== undefined) {
    console.log("keys", i, Object.keys(row).join("|"));
    console.log(
      "entries",
      i,
      Object.entries(row)
        .map(([k, v]) => k + "=" + v)
        .join(";"),
    );
  }
}

function rowAt(kind: number): A | B | undefined {
  if (kind === 0) return { a: "six", b: "seven" };
  if (kind === 1) return { c: "eight" };
  return undefined;
}

function entriesAt(kind: number): string {
  try {
    return String(Object.entries(rowAt(kind)!).length);
  } catch (error) {
    return (error as Error).name + ": " + (error as Error).message;
  }
}

console.log("record", entriesAt(0));
console.log("other", entriesAt(1));
console.log("unit", entriesAt(2));
