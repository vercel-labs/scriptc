// A value read from a record keeps the union of every arm its storage can
// hold, including an array arm the checker rules out at the guarded use.
// BigInt dispatches that storage by tag, so the array arm lowers the way
// Node's ToPrimitive does instead of refusing the call site.
type Row = number | number[] | string;

function describe(value: Row): void {
  if (typeof value === "number") {
    console.log("number", String(BigInt(value)));
  } else if (typeof value === "string") {
    console.log("string", String(BigInt(value)));
  } else {
    console.log("array", String(value.length));
  }
}

const table: Record<string, Row> = { count: 4, label: " 5 ", items: [1, 2] };
describe(table["count"]);
describe(table["label"]);
describe(table["items"]);
