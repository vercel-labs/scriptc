// An optional `unknown`/`any` record field rides the checked-dynamic slot
// and has an ABSENT state. An omitted or deleted one is NOT an own
// property: `in`, Object.hasOwn, Object.keys, spread, inspect and JSON all
// agree with Node, while an explicit `undefined` stays present.
interface Result {
  content: string[];
  structured?: unknown;
}

// An omitted field is absent, not present-and-undefined.
const omitted: Result = { content: [] };
console.log(
  "omitted",
  "structured" in omitted,
  Object.keys(omitted).join(","),
  Object.hasOwn(omitted, "structured"),
);
console.log(omitted);
const spread = { ...omitted };
console.log("spread", "structured" in spread, Object.keys(spread).join(","), JSON.stringify(spread));
console.log("entries", Object.entries(omitted).length);

// `delete` of a present field leaves the absent state behind.
const r: Result = { content: ["a"], structured: { n: 1 } };
const next: unknown = undefined;
if (next === undefined) delete r.structured;
else r.structured = next;
console.log("deleted", "structured" in r, Object.keys(r).join(","), JSON.stringify(r));
console.log(r);
const afterDelete = { ...r };
console.log("afterDelete", "structured" in afterDelete, Object.keys(afterDelete).join(","));

// A spread source a later own property captures keeps the absent state: the
// snapshot's ordinary arm holds the checked-dynamic undefined while the
// presence test stays false.
const captured = { ...omitted, n: 1 };
const nested = { ...captured, config: { ...captured } };
console.log("captured", "structured" in nested, Object.keys(nested).join(","), JSON.stringify(nested));

// An explicit undefined is a present property again.
r.structured = undefined;
console.log(
  "rewritten",
  "structured" in r,
  Object.keys(r).join(","),
  Object.hasOwn(r, "structured"),
  r.structured === undefined,
);

// The same for an `any` field.
interface Ev {
  type: string;
  payload?: any;
}
const e: Ev = { type: "t", payload: [1] };
delete e.payload;
console.log("any", "payload" in e, Object.keys(e).join(","), JSON.stringify(e));

// A union receiver deletes per arm.
interface A {
  kind: "a";
  content: string[];
  structured?: unknown;
}
interface B {
  kind: "b";
  content: string[];
  structured?: unknown;
  extra: number;
}
function clear(entry: A | B): void {
  delete entry.structured;
}
const a: A = { kind: "a", content: [], structured: 1 };
const b: B = { kind: "b", content: [], structured: "x", extra: 2 };
clear(a);
clear(b);
console.log("union", Object.keys(a).join(","), Object.keys(b).join(","), JSON.stringify(b));

// A checked-dynamic value cast to the record: a missing JSON key is absent,
// a key holding null is present.
const fromJson = JSON.parse('{"content":[]}') as Result;
const withNull = JSON.parse('{"content":[],"structured":null}') as Result;
console.log(
  "cast",
  "structured" in fromJson,
  Object.keys(fromJson).join(","),
  "structured" in withNull,
  withNull.structured === null,
);
console.log(
  "castEntries",
  Object.entries(withNull)
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join(" "),
);
