// The vitest test runner of a CI test task (scripts/ci-test.mjs sets SCRIPTC_CI_FAILURES, and vitest.config.ts
// then selects this runner). It runs each test as vitest's own runner does, and records in the test's meta how
// many errors its body threw over its attempts (`scriptcBodyErrors`). vitest adds an error from a beforeEach or
// afterEach hook, an expect.assertions count or a soft assertion to the same test result, with nothing to tell it
// from the body's; scripts/ci-failure-reporter.mjs counts a failed test as quarantinable only when every error of
// its result is one its body threw.
import { VitestTestRunner } from "vitest/runners";
import { getFn } from "vitest/suite";

export default class CiQuarantineRunner extends VitestTestRunner {
  async runTask(test) {
    const fn = getFn(test);
    if (!fn) throw new Error("Test function is not found. Did you add it using `setFn`?");
    try {
      await fn();
    } catch (error) {
      // vitest records each element of a thrown array as an error of its own.
      test.meta.scriptcBodyErrors =
        (test.meta.scriptcBodyErrors ?? 0) + (Array.isArray(error) ? error.length : 1);
      throw error;
    }
  }
}
