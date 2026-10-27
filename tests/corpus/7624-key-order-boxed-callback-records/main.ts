// A native callback handed to JavaScript inside an options record receives
// records JavaScript builds: copies and enumerations of them follow the
// order JavaScript wrote, also when the TypeScript literals of the type
// write another order and spread their own type.
import { each } from "./lib.js";

interface Row {
  a: number;
  b: number;
}

function show(label: string, row: Row): void {
  const copy = { ...row };
  console.log(label, Object.keys(row).join(), JSON.stringify(copy), Object.keys(copy).join());
}

const literal: Row = { b: 20, a: 10 };
show("literal", literal);
show("self copy", { ...literal, b: 21 });
const seen: Row[] = [];
each({
  visit: (row: Row) => {
    seen.push(row);
    show("callback", row);
  },
});
console.log(JSON.stringify(seen), JSON.stringify(seen.map((row) => ({ ...row, a: row.a * 2 }))));
