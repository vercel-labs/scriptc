// Object.values over typed records whose values are `object` or `unknown`:
// the list comes from the record's live view, so a record that kept
// undeclared keys of its source lists them too, an absent optional key is
// skipped and a present undefined is listed.
interface Slots {
  first: object;
  third: unknown;
  second?: object;
}
const slots: Slots = { first: { n: 1 }, third: "three" };
console.log(Object.values(slots).map((value) => JSON.stringify(value)).join(","));
slots.second = { n: 2 };
console.log(
  Object.values(slots)
    .filter((value) => typeof value === "object")
    .map((value) => (value as { n: number }).n)
    .join(","),
);
const explicit: Slots = { first: {}, third: undefined, second: undefined };
console.log(
  Object.values(explicit).length,
  Object.values(explicit).map((value) => String(value)).join(","),
);

// A record converted from a parsed value keeps the keys its type does not
// declare, in the source's order.
const parsed = JSON.parse('{"zeta":{"z":1},"third":3,"first":{"n":9},"7":"seven"}') as Slots;
console.log(Object.values(parsed).map((value) => JSON.stringify(value)).join(","));
console.log(
  Object.values(parsed)
    .flatMap((value) => (typeof value === "object" && value !== null ? Object.values(value) : [value]))
    .join(","),
);

// A dictionary whose values are records with `object` fields.
interface Entry {
  id: string;
  payload: object;
}
const entries: Record<string, Entry> = {
  x: { id: "x", payload: { a: 1, b: [2] } },
  y: { id: "y", payload: { c: 3 } },
};
console.log(
  Object.values(entries)
    .flatMap((entry) => Object.values(entry.payload))
    .map((value) => JSON.stringify(value))
    .join(","),
);
console.log(
  Object.values(entries)
    .flatMap((entry) => Object.values(entry))
    .map((value) => (typeof value === "string" ? value : Object.keys(value as object).join("")))
    .join(","),
);

// A hybrid: declared fields and an index signature of `unknown`.
interface Tagged {
  name: string;
  [extra: string]: unknown;
}
const tagged: Tagged = { name: "t", level: 3, nested: { ok: true } };
console.log(
  Object.values(tagged)
    .map((value) => (typeof value === "object" ? JSON.stringify(value) : String(value)))
    .join(","),
);

// for...of and an indexed read of the same lists.
let total = 0;
for (const value of Object.values(slots)) if (typeof value === "object") total += (value as { n: number }).n;
console.log(total, JSON.stringify(Object.values(slots)[0]), Object.values(slots)[5] === undefined);
