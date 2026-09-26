// Test262 permits host implementations of its assertion functions. This
// adapter avoids JS function expandos, which currently hit a static fence.
// Keep the supported surface small and check it against the upstream helpers.
import nodeAssert from "node:assert/strict";

export class Test262Error extends Error {}

function scalar(value: unknown): void {
  // Native-to-unknown conversion can copy references (notably arrays).
  // Refuse these assertions before comparing altered identities. Terminate
  // instead of throwing so a test's catch block cannot turn this into a pass.
  if ((typeof value === "object" && value !== null) || typeof value === "function") {
    console.error("SCRIPTC_TEST262_HARNESS: reference equality requires an identity-preserving adapter");
    process.exit(86);
  }
}

export function assert(value: unknown, message = "Expected true"): void {
  if (value !== true) throw new Test262Error(message);
}

export namespace assert {
  export function sameValue(actual: unknown, expected: unknown, message = "Expected SameValue"): void {
    scalar(actual);
    scalar(expected);
    try {
      nodeAssert.strictEqual(actual, expected);
    } catch {
      throw new Test262Error(message);
    }
  }

  export function notSameValue(actual: unknown, expected: unknown, message = "Expected different values"): void {
    scalar(actual);
    scalar(expected);
    try {
      nodeAssert.notStrictEqual(actual, expected);
    } catch {
      throw new Test262Error(message);
    }
  }

  export function compareArray(actual: unknown, expected: unknown, message = "Expected matching array contents"): void {
    if (!Array.isArray(actual) || !Array.isArray(expected)) {
      scalar(actual);
      scalar(expected);
      throw new Test262Error(message);
    }
    if (actual.length !== expected.length) throw new Test262Error(message);
    for (let i = 0; i < actual.length; i++) {
      const left: unknown = i in actual ? actual[i] : undefined;
      const right: unknown = i in expected ? expected[i] : undefined;
      scalar(left);
      scalar(right);
      try {
        nodeAssert.strictEqual(left, right);
      } catch {
        throw new Test262Error(message);
      }
    }
  }
}
