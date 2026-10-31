// Functions whose inferred return type is a union of overlapping records.
// TypeScript's subtype reduction infers `{ status }` for a function that
// returns `{ status }` in one branch and `{ status, value }` in another, so
// the inferred type is narrower than the values. Returned values keep their
// fields, chained returns keep them, and bindings typed by the reduced type
// read their declared fields.
type Aborted = { status: string };
const ABORTED: Aborted = { status: "aborted" };

function inner(ok: boolean, value: unknown) {
  if (!ok) return ABORTED;
  return { status: "valid", value };
}

// Returns inner's union through a call: inferred as `{ status }` alone.
function outer(ok: boolean, value: unknown) {
  if (value === "stop") return ABORTED;
  return inner(ok, value);
}

function merge(entries: [string, number][]) {
  const result: Record<string, number> = {};
  for (const [key, n] of entries) {
    if (key === "__proto__") return ABORTED;
    result[key] = n;
  }
  return { status: "valid", value: result };
}

function parse(entries: [string, number][]) {
  if (entries.length === 0) return ABORTED;
  return merge(entries);
}

console.log(JSON.stringify(outer(true, [1, 2])));
console.log(JSON.stringify(outer(false, 1)));
console.log(JSON.stringify(outer(true, "stop")));
console.log(JSON.stringify(parse([["a", 1], ["b", 2]])));
console.log(JSON.stringify(parse([])));

// Into untyped positions: the value keeps every field.
const seen: unknown[] = [];
seen.push(outer(true, { nested: true }));
seen.push(parse([["c", 3]]));
console.log(JSON.stringify(seen));
const loose: unknown = outer(true, "kept");
console.log(JSON.stringify(loose));

// Bindings typed by the reduced type: declared fields read as in Node.
const r = outer(true, 42);
console.log(r.status);
let status = "";
for (const ok of [true, false]) status += outer(ok, 0).status + " ";
console.log(status.trim());
function statusOf(ok: boolean): string {
  const local = outer(ok, null);
  return local.status;
}
console.log(statusOf(true), statusOf(false));
