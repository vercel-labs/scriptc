// A plain-JavaScript package typed by an @types package: rows the
// declarations type as plain data become native records; the cursor, a
// constructor-function instance its declarations describe with an
// interface, keeps its JavaScript-world typing.
import { parseRows, cursor, type Row } from "rowparse";

const rows: Row[] = parseRows("name,qty\napple,3\npear,5\nfig,2\n");
let total = 0;
for (const r of rows) total += Number(r.cells["qty"]);
console.log("total", total, rows.length);
const widest = rows.reduce((w, r) => Math.max(w, r.width), 0);
console.log("widest", widest);
rows[0]!.cells["qty"] = "30";
console.log("first", JSON.stringify(rows[0]), Object.keys(rows[1]!.cells).join("|"));
const sorted = [...rows].sort((a, b) => a.cells["name"]!.localeCompare(b.cells["name"]!)).map((r) => r.line);
console.log("sorted", sorted.join(","));
const c = cursor("abcdef");
c.pos = 2;
console.log("cursor", c.remaining(), c.text);
