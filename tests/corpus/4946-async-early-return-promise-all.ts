// An async function that returns its first parameter early, depending on its
// second, mapped over rows whose results go to Promise.all and are assigned
// back to the rows. Promise.all fulfills with each entry's settled value, so
// its result holds undefined only where an entry is missing: the reassigned
// rows, the map callback's row, the function's parameter and its early return
// keep their declared types, and loop bindings over the result take literal
// and computed-key writes. The early return hands back the same row objects
// when the include list is empty, so writes through the result reach them.

type Row = Record<string, unknown> & { id?: string | number };

async function load(row: Row, includes: string[]): Promise<Row> {
  if (includes.length === 0) return row;
  const out: Row = Object.fromEntries(Object.entries(row));
  for (const name of includes) out[name] = await Promise.resolve(`${name}-${row.id}`);
  return out;
}

async function loadSingleExit(row: Row, includes: string[]): Promise<Row> {
  let out: Row = row;
  if (includes.length > 0) {
    out = Object.fromEntries(Object.entries(row));
    for (const name of includes) out[name] = await Promise.resolve(name.length);
  }
  return out;
}

function show(rows: Row[], keys: string[]): string {
  return rows.map((row) => keys.map((key) => `${key}=${String(row[key])}`).join(" ")).join(" | ");
}

async function main(): Promise<void> {
  const source: Row[] = [{ id: "a" }, { id: 2 }, { id: "c", note: "kept" }];
  let rows: Row[] = source;
  const includes: string[] = [];
  if (process.argv.length < 99) includes.push("x");
  rows = await Promise.all(rows.map((row) => load(row, includes)));
  for (const row of rows) row["seen"] = true;
  console.log(show(rows, ["id", "x", "seen", "note"]));
  console.log(rows.map((row, i) => row === source[i]).join(","));

  const none: string[] = [];
  if (process.argv.length > 99) none.push("never");
  const same = await Promise.all(source.map((row) => load(row, none)));
  console.log(same.map((row, i) => row === source[i]).join(","));
  console.log(show(same, ["id", "x", "seen"]));

  const field = process.argv.length < 99 ? "tag" : "other";
  for (const row of same) row[field] = `t-${String(row.id)}`;
  for (const row of rows) row[field] = row[field] ?? "fresh";
  console.log(show(source, ["id", "tag"]));
  console.log(show(rows, ["id", "tag"]));

  const single = await Promise.all(source.map((row) => loadSingleExit(row, ["ab", "c"])));
  for (const row of single) row[field] = null;
  console.log(show(single, ["id", "ab", "c", "tag"]));
  const untouched = await Promise.all(source.map((row) => loadSingleExit(row, none)));
  console.log(untouched.every((row, i) => row === source[i]));

  const head: Row = { id: "h" };
  const one = await load(head, includes);
  const back = await load(head, none);
  console.log(one["x"], one === head, back === head);
}

await main();
