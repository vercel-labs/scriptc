// A vitest reporter for scripts/ci-test.mjs: when SCRIPTC_CI_FAILURES names a file, it writes there, as the run
// ends, the tests that failed and every error outside a test, so the CI runner can tell a run whose only failures
// are quarantined flaky tests (scripts/ci-quarantine.mjs) from any other failure. It writes nothing otherwise.
//
// { "tests": [{ "file": "tests/harness/x.test.ts", "name": "the test's own name", "fullName": "suite > test" }],
//   "other": ["descriptions of unhandled errors, failed hooks and files that failed outside their tests"] }

import { writeFileSync } from "node:fs";
import { relative } from "node:path";

const describe = (error) => String(error?.message ?? error).split("\n", 1)[0];

export function failureReport(testModules, unhandledErrors = [], root = process.cwd(), reason) {
  const tests = [];
  const other = unhandledErrors.map((error) => `unhandled error: ${describe(error)}`);
  if (reason === "interrupted") other.push("the run was interrupted");
  for (const testModule of testModules) {
    const file = relative(root, testModule.moduleId).replaceAll("\\", "/");
    for (const error of testModule.errors()) other.push(`${file}: ${describe(error)}`);
    for (const suite of testModule.children.allSuites())
      for (const error of suite.errors())
        other.push(`${file} > ${suite.fullName}: ${describe(error)}`);
    let failedTests = 0;
    for (const testCase of testModule.children.allTests()) {
      if (testCase.result().state !== "failed") continue;
      failedTests++;
      tests.push({ file, name: testCase.name, fullName: testCase.fullName });
    }
    // A file can fail with no failed test and no error of its own (a failure vitest records elsewhere).
    if (testModule.state() === "failed" && failedTests === 0 && testModule.errors().length === 0)
      other.push(`${file}: failed without a failed test`);
  }
  return { tests, other };
}

export default class CiFailureReporter {
  constructor({ path = process.env.SCRIPTC_CI_FAILURES, root = process.cwd() } = {}) {
    this.path = path;
    this.root = root;
  }

  onTestRunEnd(testModules, unhandledErrors, reason) {
    if (!this.path) return;
    writeFileSync(
      this.path,
      JSON.stringify(failureReport(testModules, unhandledErrors, this.root, reason)),
    );
  }
}
