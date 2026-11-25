// `delete` of a key the operand's TYPE does not declare: Node's object still
// holds the property (a checked record keeps its source's undeclared keys in
// the kept-source table), so the delete removes it there and every
// reflective surface — Object.keys, `in`, JSON, untyped reads — follows. The
// coding agent's v1-to-v2 session migration: a parsed entry narrowed to a
// union arm, viewed with an extra optional key, rewritten and deleted.
interface Base {
  type: string;
  id: string;
}
interface Compaction extends Base {
  type: "compaction";
  summary: string;
  firstKeptId: string;
}
interface Note extends Base {
  type: "note";
  text: string;
}
type Entry = Compaction | Note;

const lines = [
  '{"type":"note","id":"a","text":"hi"}',
  '{"type":"compaction","id":"b","summary":"s","firstKeptId":"","firstKeptIndex":1}',
];
const entries = lines.map((l) => JSON.parse(l) as Entry);
for (const entry of entries) {
  if (entry.type === "compaction") {
    const comp = entry as Compaction & { firstKeptIndex?: number };
    console.log(typeof comp.firstKeptIndex, "firstKeptIndex" in comp);
    if (typeof comp.firstKeptIndex === "number") {
      const target = entries[comp.firstKeptIndex];
      if (target) comp.firstKeptId = target.id;
      delete comp.firstKeptIndex;
    }
    console.log(JSON.stringify(comp), Object.keys(comp).join(","), "firstKeptIndex" in comp);
    console.log((comp as unknown as Record<string, unknown>)["firstKeptIndex"] === undefined);
  }
}
console.log(JSON.stringify(entries));

// The delete's own answer, in value position: true for a key the record
// held, and true for one it never had (JavaScript's answer for a missing
// own property — nothing changes).
const held = JSON.parse('{"type":"note","id":"c","text":"x","extra":7}') as Note & {
  extra?: number;
};
const missing = JSON.parse('{"type":"note","id":"d","text":"y"}') as Note & {
  extra?: number;
};
console.log(delete held.extra, "extra" in held, JSON.stringify(held));
console.log(delete missing.extra, "extra" in missing, JSON.stringify(missing));

// The other undeclared keys keep their order around the deleted one, and the
// record is the same object through an untyped alias.
const multi = JSON.parse('{"type":"note","id":"e","text":"z","a":1,"b":2,"c":3}') as Note & {
  b?: number;
};
const multiView = multi as unknown as Record<string, unknown>;
console.log(multiView["b"], Object.keys(multi).join(","));
delete multi.b;
console.log(Object.keys(multi).join(","), JSON.stringify(multi), multiView["b"] === undefined);

// A frozen record keeps an undeclared key: strict code refuses the delete
// with Node's TypeError and the key stays, while a key the record never had
// deletes fine either way.
const frozen = JSON.parse('{"type":"note","id":"f","text":"q","extra":1}') as Note & {
  extra?: number;
};
Object.freeze(frozen);
try {
  delete frozen.extra;
  console.log("no throw");
} catch (err) {
  console.log(err instanceof TypeError, (err as Error).message);
}
console.log(JSON.stringify(frozen), "extra" in frozen, Object.keys(frozen).join(","));
console.log(delete (frozen as unknown as { gone?: number }).gone);
console.log(JSON.stringify(frozen));
