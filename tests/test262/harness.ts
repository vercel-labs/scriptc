// Test262 permits host implementations of its assertion functions. This
// adapter avoids JS function expandos, which currently hit a static fence.
// Keep the supported surface small and check it against the upstream helpers.
import nodeAssert from "node:assert/strict";
import { throwsOutcome } from "./assert-throws.js";

export class Test262Error extends Error {}

let asyncDone = false;

export function $DONE(error?: unknown): void {
  if (asyncDone || error) {
    console.error("SCRIPTC_TEST262_HARNESS: async completion failed");
    process.exit(87);
  }
  asyncDone = true;
  console.log("__scriptc_test262_complete__");
}

function reference(value: unknown): boolean {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}

function refuse(): never {
  // Native-to-unknown conversion can copy references (notably arrays), so
  // two distinct references may be one value in the program. Terminate
  // instead of throwing so a test's catch block cannot turn this into a pass.
  console.error("SCRIPTC_TEST262_HARNESS: reference equality requires an identity-preserving adapter");
  process.exit(86);
}

function scalar(value: unknown): void {
  if (reference(value)) refuse();
}

/** The upstream helpers accept any message value and convert it to a string. */
function text(message: unknown, fallback: string): string {
  return message === undefined ? fallback : String(message);
}

/** SameValue of two operands. A copy made at the conversion boundary can only
 * separate one reference into two, so identical references are the same value
 * and a reference is never the same value as a primitive. Two distinct
 * references refuse. */
function same(actual: unknown, expected: unknown): boolean {
  if (reference(actual) || reference(expected)) {
    if (actual === expected) return true;
    if (reference(actual) && reference(expected)) refuse();
    return false;
  }
  try {
    nodeAssert.strictEqual(actual, expected);
    return true;
  } catch {
    return false;
  }
}

export function assert(value: unknown, message?: unknown): void {
  if (value !== true) throw new Test262Error(text(message, "Expected true"));
}

export namespace assert {
  export function sameValue(actual: unknown, expected: unknown, message?: unknown): void {
    if (!same(actual, expected)) throw new Test262Error(text(message, "Expected SameValue"));
  }

  export function notSameValue(actual: unknown, expected: unknown, message?: unknown): void {
    if (same(actual, expected)) throw new Test262Error(text(message, "Expected different values"));
  }

  export function throws(expectedErrorConstructor: unknown, func: () => unknown, message?: unknown): void {
    const outcome = throwsOutcome(expectedErrorConstructor, func);
    if (outcome === "invalid") throw new Test262Error("assert.throws requires a function to run");
    if (outcome === "unsupported") {
      console.error("SCRIPTC_TEST262_HARNESS: assert.throws needs an Error instance");
      process.exit(86);
    }
    if (outcome !== "pass") throw new Test262Error(text(message, "Expected exception"));
  }

  /** Converts `message` only when the contents differ, as the upstream helper does. */
  export function compareArray(actual: unknown, expected: unknown, message?: unknown): void {
    if (!Array.isArray(actual) || !Array.isArray(expected)) {
      scalar(actual);
      scalar(expected);
      throw new Test262Error(text(message, "Expected matching array contents"));
    }
    let matches = actual.length === expected.length;
    for (let i = 0; matches && i < actual.length; i++) {
      const left: unknown = i in actual ? actual[i] : undefined;
      const right: unknown = i in expected ? expected[i] : undefined;
      matches = same(left, right);
    }
    if (!matches) throw new Test262Error(text(message, "Expected matching array contents"));
  }
}
