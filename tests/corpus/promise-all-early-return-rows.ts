// Rows mapped through an async loader and gathered with Promise.all, then
// assigned back to the same binding. The loader returns its row parameter
// early when there is nothing to add. Promise.all fulfills with each
// entry's settled value, so the result holds undefined only where an entry
// can be missing: the rows, the callback's parameter and the loader's
// return keep their declared types, and writes through loop bindings over
// the result reach the same objects the early return handed back.

type Row = Record<string, unknown> & { id?: string | number };

async function enrich(row: Row, extras: string[]): Promise<Row> {
  if (extras.length === 0) return row;
  const copy: Row = { ...row };
  for (const extra of extras) copy[extra] = await Promise.resolve(`${extra}:${String(row.id)}`);
  return copy;
}

async function enrichOnce(row: Row, extras: string[]): Promise<Row> {
  let result: Row = row;
  if (extras.length > 0) {
    result = { ...row };
    for (const extra of extras) result[extra] = extra.length;
  }
  return result;
}

function render(rows: Row[], keys: string[]): string {
  return rows.map((row) => keys.map((key) => `${key}=${String(row[key])}`).join(",")).join(" ");
}

async function main(): Promise<void> {
  const base: Row[] = [{ id: 1 }, { id: "two" }, { id: 3, kept: true }];
  const extras: string[] = [];
  if (process.argv.length > 0) extras.push("label");
  const nothing: string[] = [];

  let rows: Row[] = base;
  rows = await Promise.all(rows.map((row) => enrich(row, extras)));
  for (const row of rows) row["visited"] = "yes";
  console.log(render(rows, ["id", "label", "visited", "kept"]));
  console.log(rows.map((row, i) => row === base[i]).join(" "));

  const same = await Promise.all(base.map((row) => enrich(row, nothing)));
  console.log(same.map((row, i) => row === base[i]).join(" "));
  const key = process.argv.length > 0 ? "mark" : "unused";
  for (const row of same) row[key] = `m${String(row.id)}`;
  console.log(render(base, ["id", "mark"]));

  const once = await Promise.all(base.map((row) => enrichOnce(row, ["ab"])));
  for (const row of once) row[key] = null;
  console.log(render(once, ["id", "ab", "mark"]));

  // An entry that can be missing still makes the result possibly undefined.
  const holes = await Promise.all([enrich(base[0]!, nothing), undefined]);
  console.log(holes.length, holes[1] === undefined, holes[0] === base[0]);
}

await main();
