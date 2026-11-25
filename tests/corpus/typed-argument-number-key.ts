// A record whose fields are named by number-like strings, written through an
// untyped helper with run-time keys.
type Row = { 0: number; 1: number; label: string };

function bump(target: unknown, key: string, by: number): void {
  const record = target as Record<string, number>;
  if (key in record) record[key] = record[key]! + by;
}

const row: Row = { 0: 1, 1: 2, label: "r" };
for (let i = 0; i < 10; i++) bump(row, i % 2 === 0 ? "0" : "1", i);
bump(row, "2", 100);
console.log(row[0], row[1], row.label, Object.keys(row).join(","));
