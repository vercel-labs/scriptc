// `delete` of a key the operand's own type does not declare, addressed at a
// narrowed copy of the record that keeps the key. Node has one object, so
// the delete reaches the kept property however many records spell the value:
// through a checked view of the copy, through a chain of copies one of which
// was frozen, and through a copy no other code observes.
interface Compaction {
  type: "compaction";
  id: string;
  summary: string;
}
interface Pair {
  type: string;
  summary: string;
}
interface OnlyType {
  type: string;
}
interface Middle {
  type: string;
  id: string;
}
interface Lonely {
  id: string;
  summary: string;
}

// A checked view of a narrowed copy: boxing the copy and converting the
// capsule to a type it has all the fields for answers a view of the copy,
// whose own link reaches the record that keeps the key.
const viewedSource = JSON.parse(
  '{"type":"compaction","id":"v","summary":"a","firstKeptIndex":1}',
) as Compaction;
const viewedCopy: Pair = viewedSource;
console.log(JSON.stringify(viewedCopy), Object.keys(viewedCopy).join(","));
const boxedCopy: unknown = viewedCopy;
const viewOfCopy = boxedCopy as OnlyType;
console.log(delete (viewOfCopy as OnlyType & { firstKeptIndex?: number }).firstKeptIndex);
console.log(JSON.stringify(viewedSource), "firstKeptIndex" in viewedSource);

// A frozen intermediate copy: `middle` copies `chainSource` (keeping its
// `summary` key behind) and `leaf` copies `middle` (keeping its `id` key
// behind). Node froze the one object, so the delete through `leaf` throws.
const chainSource = JSON.parse(
  '{"type":"compaction","id":"m","summary":"b","firstKeptIndex":2}',
) as Compaction;
const middle: Middle = chainSource;
const leaf: OnlyType = middle;
Object.freeze(middle);
try {
  delete (leaf as OnlyType & { firstKeptIndex?: number }).firstKeptIndex;
  console.log("no throw");
} catch (error) {
  console.log(error instanceof TypeError, (error as Error).message);
}
console.log(JSON.stringify(chainSource), "firstKeptIndex" in chainSource);

// A narrowed copy only the delete observes: nothing reads `lonely` through
// its own type, so the copy still has to reach the record that keeps the
// key for the delete to remove it there.
const lonelySource = JSON.parse(
  '{"type":"compaction","id":"l","summary":"c","firstKeptIndex":3}',
) as Compaction;
const lonely: Lonely = lonelySource;
console.log(delete (lonely as Lonely & { firstKeptIndex?: number }).firstKeptIndex);
console.log(JSON.stringify(lonelySource), "firstKeptIndex" in lonelySource);
