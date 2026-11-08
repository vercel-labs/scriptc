// A union keeps a discriminant only when every record arm holds the member.
// Here one arm of the source lacks it (`Shelf`), or the source is a record
// beside `undefined`, so the source union keeps none while the destination
// does. Each source arm that fits several destination arms by width then
// enters by the value of its own discriminant, as the record alone would.

type Shelf = { aisle: number; row: string };
type OnLoan = { status: "loan"; member: string; due: number; renewals?: number };
type Held = { status: "held"; until?: number };
type Lost = { status: "lost"; fee: number; note?: "damaged" | "missing" };
type Copy = OnLoan | Held | Lost;
type Audited = Copy & { checked?: boolean; flagged?: boolean };

function locate(n: number): Shelf | Copy {
  switch (n) {
    case 0:
      return { aisle: 4, row: "C" };
    case 1:
      return { status: "held" };
    case 2:
      return { status: "held", until: 20 };
    case 3:
      return { status: "lost", fee: 12, note: "damaged" };
    case 4:
      return { status: "lost", fee: 3 };
    case 5:
      return { status: "loan", member: "m-17", due: 9, renewals: 2 };
    default:
      return { status: "loan", member: "m-40", due: 30 };
  }
}

function line(copy: Audited): string {
  const flags = (copy.checked ? "checked" : "unchecked") + ("flagged" in copy ? " flagged" : "");
  if (copy.status === "loan")
    return `loan ${copy.member} due ${copy.due} renewals ${copy.renewals ?? 0} (${flags})`;
  if (copy.status === "lost") return `lost fee ${copy.fee} ${copy.note ?? "no note"} (${flags})`;
  return `held until ${copy.until ?? "collected"} (${flags})`;
}

// Returned.
function audit(n: number): Audited {
  const found = locate(n);
  if ("status" in found) {
    return found;
  }
  return { status: "lost", fee: 0, flagged: true };
}

// Returned from an async function.
async function auditLater(n: number): Promise<Audited> {
  const found = locate(n);
  if ("status" in found) return found;
  return { status: "held", checked: true };
}

// An argument, an annotated binding, a field and an element.
function describe(n: number): string {
  const found = locate(n);
  if (!("status" in found)) return `shelf ${found.aisle}${found.row}`;
  const kept: Audited = found;
  const slot: { copy: Audited; n: number } = { copy: found, n };
  const list: Audited[] = [];
  list.push(found);
  return [line(found), line(kept), line(slot.copy), line(list[0]!), JSON.stringify(kept)].join(" | ");
}

for (let n = 0; n < 7; n++) {
  const audited = audit(n);
  console.log(n, line(audited), JSON.stringify(audited), Object.keys(audited).join(","));
}
for (let n = 0; n < 7; n++) console.log(n, line(await auditLater(n)));
for (let n = 0; n < 7; n++) console.log(n, describe(n));

// A record beside `undefined`, asserted into a union discriminated by a
// member the record holds as a plain string: the record's own conversion,
// which selects the arm by that member's value.
type ByShelf = { by: "shelf"; value: string };
type ByField = { by: "title" | "author" | "year"; field: string; value?: string };
type Query = ByShelf | ByField;
type Loose = { by: string; field?: string; value?: unknown };

function show(query: Query): string {
  if (query.by === "shelf") return `shelf=${query.value}`;
  return `${query.by}:${query.field}${query.value !== undefined ? "=" + query.value : ""}`;
}

function first(queries: (Loose | undefined)[]): string {
  const head = queries[0];
  return show(head as Query);
}

function all(queries: Loose[]): string {
  const padded: (Loose | undefined)[] = queries;
  return padded.map((query) => show(query as Query)).join(", ");
}

console.log(first([{ by: "shelf", value: "4C" }]));
console.log(first([{ by: "author", field: "last", value: "Lem" }]));
console.log(
  all([
    { by: "title", field: "exact" },
    { by: "year", field: "from", value: "1961" },
    { by: "shelf", value: "9A" },
  ]),
);
