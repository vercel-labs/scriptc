// Own-property presence of optional record fields: an omitted field is
// absent, while a field written with an explicit undefined is present.
// Every key surface agrees: `in`, Object.keys/values/entries, hasOwn,
// for-in, inspection, deep equality, and JSON.
import * as assert from "node:assert";
import * as util from "node:util";

interface Item {
  sku: string;
  count?: number;
  note?: string;
}

function keysOf(item: Item): string {
  const out: string[] = [];
  for (const key in item) out.push(key);
  return out.join("|");
}

function report(label: string, item: Item): void {
  console.log(label, "count" in item, "note" in item, Object.hasOwn(item, "note"));
  console.log(" keys", Object.keys(item), keysOf(item));
  console.log(" values", Object.values(item));
  console.log(" entries", Object.entries(item));
  console.log(" log", item);
  console.log(" inspect", util.inspect(item), JSON.stringify(item));
}

const omitted: Item = { sku: "a-1" };
const explicitNote: Item = { sku: "a-2", note: undefined };
const full: Item = { sku: "a-3", count: 4, note: "boxed" };
const explicitBoth: Item = { sku: "a-4", count: undefined, note: undefined };
report("omitted", omitted);
report("explicit", explicitNote);
report("full", full);
report("both", explicitBoth);

// A required field whose type admits undefined is always present.
interface Slot {
  value: number | undefined;
}
const slot: Slot = { value: undefined };
console.log("value" in slot, Object.keys(slot).join(","), slot);

// Optional parameters forwarded into an explicit property stay present.
function make(sku: string, count?: number): Item {
  return { sku, count };
}
console.log(make("b-1"), "count" in make("b-1"), Object.keys(make("b-2", 2)));

// Deep equality compares own keys: absent and present-undefined differ.
console.log(util.isDeepStrictEqual(omitted, { sku: "a-1" } as Item));
console.log(util.isDeepStrictEqual(omitted, { sku: "a-1", note: undefined } as Item));
try {
  assert.deepStrictEqual(explicitNote, { sku: "a-2" } as Item);
  console.log("deep equal");
} catch {
  console.log("deep differ");
}

// Nested records keep presence per object.
const nested = { first: omitted, rest: [explicitNote, full] };
console.log(nested);
console.log(JSON.stringify(nested));

// A record whose optional fields are all absent inspects as {}.
interface Filters {
  tag?: string;
  min?: number;
}
const none: Filters = {};
const some: Filters = { tag: undefined };
console.log(none, some, util.inspect({ inner: none }), Object.keys(none).length);
