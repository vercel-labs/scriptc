// A vitest reporter for scripts/ci-test.mjs: when SCRIPTC_CI_FAILURES names a file, it writes there, as the run
// ends, the tests that failed and every error outside a test, so the CI runner can tell a run whose only failures
// are quarantined flaky tests (scripts/ci-quarantine.mjs) from any other failure. It writes nothing otherwise.
//
// { "tests": [{ "file": "tests/harness/x.test.ts", "name": "the test's own name", "fullName": "suite > test" }],
//   "other": ["descriptions of unhandled errors, failed hooks, failures outside a test's body and files that
//             failed outside their tests"] }

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
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
      const result = testCase.result();
      if (result.state !== "failed") continue;
      failedTests++;
      // Only a failure the test's body threw can be a flaky test's: scripts/ci-quarantine-runner.mjs counts those
      // errors. vitest adds hook errors, an expect.assertions count or a soft assertion to the same result.
      const errors = result.errors?.length ?? 0;
      const bodyErrors = testCase.meta()?.scriptcBodyErrors ?? 0;
      if (bodyErrors > 0 && errors === bodyErrors)
        tests.push({ file, name: testCase.name, fullName: testCase.fullName });
      else
        other.push(
          `${file} > ${testCase.fullName}: ${errors - bodyErrors} of its ${errors} errors came from outside its body ` +
            "(a hook, an assertion count or a soft assertion)",
        );
    }
    // A file can fail with no failed test and no error of its own (a failure vitest records elsewhere).
    if (testModule.state() === "failed" && failedTests === 0 && testModule.errors().length === 0)
      other.push(`${file}: failed without a failed test`);
  }
  return { tests, other };
}

export default class CiFailureReporter {
  constructor({
    path = process.env.SCRIPTC_CI_FAILURES ??
      (process.env.SCRIPTC_CI_FAILURE_ARCHIVE
        ? join(process.env.SCRIPTC_CI_FAILURE_ARCHIVE, "report.json")
        : undefined),
    root = process.cwd(),
  } = {}) {
    this.path = path;
    this.root = root;
  }

  onTestRunEnd(testModules, unhandledErrors, reason) {
    if (!this.path) return;
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(
      this.path,
      JSON.stringify(failureReport(testModules, unhandledErrors, this.root, reason)),
    );
  }
}
