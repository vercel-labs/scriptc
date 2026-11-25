// A computed-key write of null or undefined through a loop binding over an
// array whose rows can be missing at runtime (Object.values lists every
// value, present-undefined ones included). The receiver is checked before
// the write, which stores the value as written, as Node does.

type Row = Record<string, unknown> & { id?: string | number };

const table: Record<string, Row> = { a: { id: 1 }, b: { id: "two" } };
const rows: Row[] = Object.values(table);
const key = process.argv.length > 0 ? "mark" : "other";

for (const row of rows) row[key] = null;
console.log(rows.map((row) => `${String(row.id)}:${String(row[key])}`).join(" "));
console.log(rows.map((row) => Object.keys(row).join(",")).join(" "));

for (const row of rows) row[key] = undefined;
console.log(rows.map((row) => `${String(row.id)}:${String(row[key])}:${key in row}`).join(" "));
console.log(JSON.stringify(rows));
