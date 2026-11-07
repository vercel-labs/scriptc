// A fully typed program that reads closed records through every reflective
// surface. No value here comes from untyped code, so no record can hold a key
// its type does not declare, and none of these surfaces needs an untyped view
// of the record.
type Point = { x: number; y: number; label?: string };
type Line = { from: Point; to: Point };
type Flags = { on: boolean; name: string; count: number };

const origin: Point = { x: 0, y: 0 };
const named: Point = { y: 4, x: 3, label: "p" };
const line: Line = { from: origin, to: named };
const flags: Flags = { on: true, name: "f", count: 2 };

function surfaces(p: Point): string {
  const seen: string[] = [];
  for (const key in p) seen.push(key);
  const copy = { ...p };
  return [
    Object.keys(p).join(","),
    Object.values(p).join(","),
    Object.entries(p)
      .map(([key, value]) => `${key}=${value}`)
      .join(","),
    seen.join(","),
    JSON.stringify(p),
    JSON.stringify(copy),
    Object.getOwnPropertyNames(p).join(","),
    "x" in p,
    "label" in p,
    Object.hasOwn(p, "label"),
    Object.prototype.hasOwnProperty.call(p, "y"),
    p.hasOwnProperty("label"),
    String(p),
    `${Object.keys(copy).length}`,
  ].join(" | ");
}

console.log(surfaces(origin));
console.log(surfaces(named));

// Values that are themselves closed records.
console.log(Object.keys(line).join(","), Object.values(line).length);
for (const end of Object.values(line)) console.log(Object.keys(end).join(","), JSON.stringify(end));
for (const [name, end] of Object.entries(line)) console.log(name, end.x, end.y, "label" in end);
console.log(JSON.stringify(line), JSON.stringify(Object.entries(flags)));

// Inspection, and a list of records.
console.log(origin, named, line, flags);
const rows: Flags[] = [flags, { name: "g", count: 0, on: false }];
console.log(rows.map((row) => Object.keys(row).join("")).join(" "), JSON.stringify(rows));
let total = 0;
for (const row of rows) for (const key in row) total += key.length;
console.log(total);
