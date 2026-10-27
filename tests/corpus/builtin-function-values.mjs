// Builtin functions used as JavaScript values are functions: typeof,
// identity, their name, and calls through the value.
import { randomUUID, scryptSync } from "crypto";
const table = { randomUUID, scryptSync };
console.log(typeof table.randomUUID, table.randomUUID === randomUUID);
console.log(/^[0-9a-f-]{36}$/.test(table.randomUUID()));
console.log(/^[0-9a-f-]{36}$/.test(table.randomUUID(undefined)));
try {
  table.randomUUID(5);
} catch (e) {
  console.log(e.code, e.name);
}
console.log(table.randomUUID);
console.log(typeof table.scryptSync, table.scryptSync === scryptSync);
console.log(new Set([scryptSync]).has(table.scryptSync), table.scryptSync.name);
const pick = (useNative) => (useNative && table.randomUUID ? table.randomUUID() : "fallback");
console.log(pick(true).length, pick(false));
