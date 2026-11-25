// An object literal that spreads a record with run-time keys and adds
// members holds every key the spread copied, whatever type the checker
// gives the literal (`{ ...attributes, count: 4 }` is `{ count: number }`
// to the checker). Object.entries and Object.values of it answer every
// key and value to a callback written at the call and to a for...of over
// it; Object.keys, for...in and JSON.stringify list the same keys. A shelf
// label is built from a product's free-form attributes plus a stock count.
export {};

const attributes: Record<string, unknown> = { sku: "A-17", weight: 2.5, tags: ["new", "fragile"], box: { w: 3, h: 4 } };
const prices: Record<string, string> = { list: "12.00", sale: "9.50" };

function kindOf(value: unknown): string {
  return Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
}

// Written where it is enumerated.
console.log(
  "inline",
  Object.entries({ ...attributes, count: 4 })
    .map(([key, value]) => key + ":" + typeof value)
    .join(","),
);

// Through a binding: the same object, the same keys.
const labelled = { ...attributes, count: 4, shelf: "B2" };
console.log("keys", Object.keys(labelled).join(","));
console.log(
  "entries",
  Object.entries(labelled)
    .map(([key, value]) => key + ":" + kindOf(value))
    .join(","),
);
console.log(
  "pairs",
  Object.entries(labelled)
    .map((pair) => pair[0] + "/" + typeof pair[1])
    .join(","),
);
console.log(
  "values",
  Object.values(labelled)
    .map((value) => kindOf(value))
    .join(","),
);
console.log(
  "filtered",
  Object.entries(labelled)
    .filter(([, value]) => typeof value === "number")
    .map(([key]) => key)
    .join(","),
);
for (const [key, value] of Object.entries(labelled)) console.log("for-of", key, typeof value);
for (const value of Object.values(labelled)) console.log("value", kindOf(value));
for (const key in labelled) console.log("for-in", key);
console.log("json", JSON.stringify(labelled));
console.log("count", labelled.count + 1, labelled.shelf.toLowerCase());

// A string-valued record with a number added: the values are strings and a
// number, where the checker says numbers.
const priced = { ...prices, quantity: 3 };
console.log(
  "priced",
  Object.entries(priced)
    .map(([key, value]) => key + ":" + typeof value)
    .join(","),
);
console.log(
  "priced values",
  Object.values(priced)
    .map((value) => typeof value)
    .join(","),
);
for (const [key, value] of Object.entries(priced)) console.log("priced for-of", key, typeof value);
console.log("priced json", JSON.stringify(priced), priced.quantity * 2);

// A member written before the spread, a spread of a spread, and an override.
const defaults = { count: 0, ...attributes };
const again = { ...labelled, count: 9 };
console.log(
  "before",
  Object.entries(defaults)
    .map(([key, value]) => key + ":" + typeof value)
    .join(","),
);
console.log(
  "again",
  Object.entries(again)
    .map(([key, value]) => key + ":" + typeof value)
    .join(","),
  again.count,
);

// A record whose values all have the member's type keeps its typed values.
const stock: Record<string, number> = { north: 4, south: 6 };
const totals = { ...stock, west: 1 };
console.log(
  "typed",
  Object.entries(totals)
    .map(([key, value]) => key + "=" + (value + 1))
    .join(","),
  Object.values(totals).reduce((sum, value) => sum + value, 0),
);
