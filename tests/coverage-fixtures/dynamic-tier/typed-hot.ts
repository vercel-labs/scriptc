// TypeScript functions that loop over untyped values: an `any` parameter,
// an untyped JSON.parse result and an arrow function's `any` rows (SC6101
// names all three, the arrow by the name it is bound to). A cast to an
// alias of `any` blames the untyped value it produces, not the alias.
function regionTotals(items: any): Map<string, number> {
  const out = new Map<string, number>();
  for (const item of items) out.set(item.region, (out.get(item.region) ?? 0) + item.amount);
  return out;
}

function countRegions(text: string): number {
  const parsed = JSON.parse(text);
  let n = 0;
  for (let i = 0; i < parsed.length; i++) if (parsed[i].region !== "") n++;
  return n;
}

const weights = (rows: any): number => {
  let sum = 0;
  for (let i = 0; i < rows.length; i++) sum += rows[i].amount;
  return sum;
};

type Loose = any;

function entryCount(value: unknown): number {
  let n = 0;
  for (const key of value as Loose) if (key !== "") n++;
  return n;
}

const rows = [
  { amount: 3, region: "eu" },
  { amount: 4, region: "us" },
];
for (const [region, total] of regionTotals(rows)) console.log(region, total);
console.log(countRegions(JSON.stringify(rows)), weights(rows), entryCount(["a", ""]));
