import assert from "node:assert";
import { doesNotThrow, doesNotReject } from "node:assert/strict";

const error = new RangeError("boom");
doesNotThrow(() => 42, /ignored/);
try { assert.doesNotThrow(() => { throw error; }, (value: unknown): boolean => value === error); }
catch (actual) { console.log(actual instanceof Error ? `${actual.name}|${actual.message}` : "other"); }
try { doesNotThrow(() => { throw error; }, TypeError); }
catch (actual) { console.log("identity", actual === error); }
async function main(): Promise<void> {
  await doesNotReject(Promise.resolve(42));
  try { await doesNotReject(Promise.reject(error), (value: unknown): boolean => value === error); }
  catch (actual) { console.log(actual instanceof Error ? `${actual.name}|${actual.message}` : "other"); }
}
void main();
