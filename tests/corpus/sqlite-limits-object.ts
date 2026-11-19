// node:sqlite's DatabaseSync#limits is one ordinary object per database: the
// same object on every read, eleven live limit properties whose values every
// reflection surface sees (keys, entries, descriptors, spread, assign, JSON,
// for-in, inspect), JavaScript-added properties and their deletion, and the
// answers a closed database gives for each of those.
import { DatabaseSync } from "node:sqlite";
import { inspect } from "node:util";

const db = new DatabaseSync(":memory:");
const limits = db.limits;

console.log("same:", db.limits === limits);
console.log("keys:", Object.keys(limits).join(","));
console.log("names:", Object.getOwnPropertyNames(limits).length);
console.log("values:", Object.values(limits).slice(0, 4).join(","));
console.log("entries:", Object.entries(limits)[6]);
console.log("hasOwn:", Object.hasOwn(limits, "length"), Object.hasOwn(limits, "nope"));
console.log("in:", "length" in limits, "toString" in limits);
console.log("desc:", JSON.stringify(Object.getOwnPropertyDescriptor(limits, "length")));
console.log("absent:", Object.getOwnPropertyDescriptor(limits, "nope"));
console.log("json:", JSON.stringify(limits));
const spread = { ...limits };
console.log("spread:", Object.keys(spread).length, spread.column);
console.log("assign:", Object.keys(Object.assign({}, limits)).length);
const visited: string[] = [];
for (const key in limits) visited.push(key);
console.log("forin:", visited.length, visited[0], visited[10]);
console.log(inspect(limits));

// JavaScript-added properties list before the limits, as V8 enumerates its
// real own properties before the interceptor's names.
const fields = limits as unknown as { extra?: number; alpha?: number; secret?: string; [key: string]: number | string | undefined };
fields.extra = 7;
fields.alpha = 2;
console.log("added:", Object.keys(limits).join(","));
console.log("addedJson:", JSON.stringify(limits).slice(0, 40));
console.log("addedValue:", fields.extra);
delete fields.extra;
console.log("deleted:", Object.keys(limits).length, Object.hasOwn(limits, "extra"));
// A write through a temporary reference is a write on the one object the
// database keeps.
const temporary: any = db.limits;
temporary.temp = 5;
console.log("temporary:", db.limits, (db.limits as any).temp, Object.keys(db.limits).includes("temp"));
console.log("limitDelete:", Object.getOwnPropertyNames(Object.getOwnPropertyDescriptor(limits, "length") ?? {}).length);

// JSON.stringify's replacer and property-list filters reach the limits
// object's properties like any object's.
fields.secret = "hide";
const redact = (key: string, value: unknown) => (key === "secret" ? undefined : value);
console.log("redacted:", JSON.stringify(limits, redact));
console.log("allowlist:", JSON.stringify(limits, ["alpha", "temp"]));
console.log("nested-redacted:", JSON.stringify({ limits }, redact));
console.log("pretty:");
console.log(JSON.stringify(limits, null, 2));
delete fields.secret;

// The live values reach the connection both ways.
limits.length = 4242;
console.log("write:", limits.length, db.limits.length);
limits.length = Infinity;
console.log("reset:", limits.length);
try {
  limits.length = 1.5;
} catch (error) {
  const e = error as { code: string; message: string };
  console.log("fractional:", e.code, e.message);
}
try {
  limits.variableNumber = -1;
} catch (error) {
  const e = error as { code: string; message: string };
  console.log("negative:", e.code, e.message);
}

// A closed database: the key list and presence checks answer without the
// connection; every value read reports the error.
db.close();
console.log("closedKeys:", Object.keys(limits).length);
let closedVisited = 0;
for (const key in limits) closedVisited++;
console.log("closedForin:", closedVisited);
console.log("closedHasOwn:", Object.hasOwn(limits, "length"), "in" in limits);
function refusal(what: string, read: () => unknown): void {
  try {
    read();
    console.log("closed" + what + ": none");
  } catch (error) {
    const e = error as { code: string; message: string };
    console.log("closed" + what + ":", e.code, e.message);
  }
}
refusal("values", () => Object.values(limits));
refusal("json", () => JSON.stringify(limits));
refusal("inspect", () => inspect(limits));
refusal("descriptor", () => Object.getOwnPropertyDescriptor(limits, "length"));
// A JavaScript-added property describes itself without the connection.
console.log("closedAdded:", JSON.stringify(Object.getOwnPropertyDescriptor(limits, "alpha")));
console.log("closedAbsent:", Object.getOwnPropertyDescriptor(limits, "nope"));
console.log("closedRead:");
try {
  console.log(limits.length);
} catch (error) {
  const e = error as { code: string; message: string };
  console.log("closedRead", e.code, e.message);
}
console.log("closedSet:");
try {
  limits.length = 10;
} catch (error) {
  const e = error as { code: string; message: string };
  console.log("closedSet", e.code, e.message);
}
