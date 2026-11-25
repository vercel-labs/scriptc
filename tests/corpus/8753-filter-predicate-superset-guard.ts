// `.filter` with a type predicate whose target is a SUPERSET of the
// receiver element's declared fields. The narrowed element is only ever
// what the value really carries: a checked-dynamic source's own properties
// are read and verified field by field at the narrowed element, never
// trusted from the predicate (a predicate that keeps a value the checks do
// not describe throws the catchable TypeError instead of inventing fields).
interface SystemMessage {
  role: "system";
  content: string;
  timestamp: number;
}

const isText = (v: unknown): boolean => typeof v === "string";
// A checked-dynamic receiver (`unknown[]`): the predicate's tests are the
// only evidence, so the narrowing checks every field of the target.
const raw: unknown[] = [
  { role: "system", content: "json", timestamp: 20 },
  { role: "user", content: "hi" },
  { role: "system", timestamp: 21 },
];
const system = raw.filter(
  (r): r is SystemMessage =>
    typeof (r as { role?: unknown }).role === "string" &&
    (r as { role: string }).role === "system" &&
    isText((r as { content?: unknown }).content) &&
    typeof (r as { timestamp?: unknown }).timestamp === "number",
);
console.log("count", system.length);
for (const message of system) console.log(message.role, message.content, message.timestamp);

function stamp(message: SystemMessage): string {
  return `${message.timestamp}:${message.content}`;
}
console.log("map", system.map(stamp).join("|"));

// A record with an index signature holds the target's fields in its
// overflow, so the same narrowing is exact there: the fields the record
// does not declare are read from the overflow, absent ones stay absent.
type Row = { role: string; [key: string]: unknown };
const rows: Row[] = [{ role: "system", content: "base", timestamp: 10 }, { role: "user" }];
function isSystem(m: { role: string }): m is SystemMessage {
  return m.role === "system";
}
const fromRow = rows.filter(isSystem);
console.log("row", fromRow.length);
for (const message of fromRow) console.log(message.role, message.content, message.timestamp);
