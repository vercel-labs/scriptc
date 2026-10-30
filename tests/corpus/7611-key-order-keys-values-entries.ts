// Object.keys, Object.values, Object.entries and Object.fromEntries over
// object literals that write the same keys in different orders.
const a = { id: 1, name: "a", ok: true };
const b = { name: "b", ok: false, id: 2 };
const c = { ok: true, id: 3, name: "c" };
for (const value of [a, b, c]) {
  console.log(Object.keys(value).join(","));
  console.log(Object.values(value).join(","));
  console.log(Object.entries(value).map(([key, item]) => `${key}=${String(item)}`).join(" "));
  console.log(JSON.stringify(Object.fromEntries(Object.entries(value))));
}

type Row = { year: number; title?: string; score: number };
const rows: Row[] = [
  { score: 1, year: 2001 },
  { title: "t", year: 2002, score: 2 },
  { year: 2003, score: 3, title: "u" },
];
for (const row of rows) console.log(Object.keys(row).join(","), Object.values(row).length);
