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

function lengthOf(value: unknown): unknown {
  return (value as { length?: unknown }).length;
}

function elementAt(value: unknown, index: number): unknown {
  return (value as Record<number, unknown>)[index];
}

/** The bare `compareArray(a, b)` the upstream `harness/assert.js` defines
 * alongside `assert`. It RETURNS a boolean (the throwing assertion is
 * `assert.compareArray`), and it has no shape checks of its own. It makes the
 * upstream reads in the upstream order: `b.length`, then `a.length`, then
 * `a.length` again before every element pair, `b[i]` before `a[i]`. A null
 * operand throws TypeError there and here, and two operands without a length
 * of their own compare equal. The loop bound converts the length the way the
 * upstream `i < a.length` does, so a length of "2" compares two elements. */
export function compareArray(actual: unknown, expected: unknown): boolean {
  if (lengthOf(expected) !== lengthOf(actual)) return false;
  for (let i = 0; i < Number(lengthOf(actual)); i++) {
    if (!same(elementAt(expected, i), elementAt(actual, i))) return false;
  }
  return true;
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

// The island lane (decision S4) assembles `assert` in JavaScript: a native
// function crosses the bridge as a callable, but the namespace members
// attached to it do not (they are properties of the native function object).
// Test262's `assert` must be callable and carry the helpers, so each helper
// is exported on its own and the island wrapper builds the object. The
// assertion form of compareArray takes its own name: `compareArray` is the
// bare function above.
export const sameValue = assert.sameValue;
export const notSameValue = assert.notSameValue;
export const assertThrows = assert.throws;
export const assertCompareArray = assert.compareArray;
