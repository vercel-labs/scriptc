// `delete` of a key the operand's own layout does not declare, addressed
// through an asserted optional view (`delete (o as T & { k?: string }).k`):
// Node erases the assertion and deletes from `o`, where the key lives in the
// record's kept source, so the delete removes it there and every reflective
// surface follows. The same delete through a narrowed width copy follows the
// copy's link to the record that keeps the key, because Node has one object.
interface Compaction {
  type: "compaction";
  id: string;
  summary: string;
}
interface Narrower {
  type: string;
}

// The assertion form: `parsed` keeps `firstKeptIndex`, which its type does
// not declare.
const parsed = JSON.parse(
  '{"type":"compaction","id":"b","summary":"s","firstKeptIndex":1}',
) as Compaction;
console.log(
  JSON.stringify(parsed),
  Object.keys(parsed).join(","),
  "firstKeptIndex" in parsed,
  (parsed as unknown as Record<string, unknown>)["firstKeptIndex"],
);
console.log(delete (parsed as Compaction & { firstKeptIndex?: number }).firstKeptIndex);
console.log(
  JSON.stringify(parsed),
  Object.keys(parsed).join(","),
  "firstKeptIndex" in parsed,
  (parsed as unknown as Record<string, unknown>)["firstKeptIndex"] === undefined,
);

// The same delete through a narrowed width copy of a record that keeps the
// key: the copy links to `source`, and the delete lands on the record whose
// kept source holds it.
const source = JSON.parse(
  '{"type":"compaction","id":"c","summary":"t","firstKeptIndex":2}',
) as Compaction;
const copy: Narrower = source;
console.log(JSON.stringify(copy), Object.keys(copy).join(","));
console.log(delete (copy as Narrower & { firstKeptIndex?: number }).firstKeptIndex);
console.log(JSON.stringify(source));
console.log(JSON.stringify(copy));
console.log("firstKeptIndex" in source, "firstKeptIndex" in copy);

// A frozen record refuses the removal, whichever binding the delete names:
// strict code throws Node's TypeError and the key stays.
const frozen = JSON.parse(
  '{"type":"compaction","id":"d","summary":"u","firstKeptIndex":3}',
) as Compaction;
const frozenCopy: Narrower = frozen;
const frozenView = frozen as Compaction & { firstKeptIndex?: number };
const frozenCopyView = frozenCopy as Narrower & { firstKeptIndex?: number };
Object.freeze(frozen);
try {
  delete frozenView.firstKeptIndex;
  console.log("no throw");
} catch (error) {
  console.log(error instanceof TypeError, (error as Error).message);
}
try {
  delete frozenCopyView.firstKeptIndex;
  console.log("no throw");
} catch (error) {
  console.log(error instanceof TypeError, (error as Error).message);
}
console.log(JSON.stringify(frozen), "firstKeptIndex" in frozenCopy);
