// CSV parsing and numeric formatting: split, Number(), parseInt,
// toFixed, String(n), and string assembly of a report.
let seed = 1001;
function random(): number {
  seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
  return seed / 4294967296;
}
function makeCsv(rows: number): string {
  const lines: string[] = ["date,store,units,unit_price,discount"];
  for (let i = 0; i < rows; i++) {
    const day = 1 + (i % 28);
    lines.push(
      `2026-${String(1 + (i % 12)).padStart(2, "0")}-${String(day).padStart(2, "0")},store-${Math.floor(random() * 40)},${Math.floor(random() * 50)},${(random() * 200).toFixed(2)},${(random() * 0.3).toFixed(3)}`,
    );
  }
  return lines.join("\n");
}

const scale = Number(process.argv[2] ?? "1");
const csv = makeCsv(Math.floor(150000 * scale));
const totals = new Map<string, number>();
const months: number[] = new Array<number>(13).fill(0);
let units = 0;
let formatted = 0;
for (let round = 0; round < 2; round++) {
  const lines = csv.split("\n");
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i]!.split(",");
    const month = parseInt(cols[0]!.slice(5, 7), 10);
    const count = Number(cols[2]);
    const price = Number(cols[3]);
    const discount = Number(cols[4]);
    const revenue = count * price * (1 - discount);
    units += count;
    months[month] = months[month]! + revenue;
    totals.set(cols[1]!, (totals.get(cols[1]!) ?? 0) + revenue);
    formatted += (revenue.toFixed(2) + "|" + String(count)).length;
  }
}
const stores = [...totals.keys()].sort();
const report = stores.map((s) => `${s}: ${totals.get(s)!.toFixed(2)}`).join("\n");
console.log(report.split("\n").slice(0, 5).join("\n"));
console.log("units", units, "formatted", formatted, "jan", months[1]!.toFixed(2), "dec", months[12]!.toFixed(2));
