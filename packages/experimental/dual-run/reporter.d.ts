import type { TestEvent } from "node:test/reporters";

/** A node:test reporter that, for every file Node ran, builds the file with
 * scriptc, runs the binary and compares its spec report, program output and
 * exit code with a plain `node <file>` run, using the documented node:test
 * normalization. A difference is reported against the test it breaks and
 * sets the exit code to 1; a file whose Node output differs between two
 * runs is reported as flaky instead. Use it with
 * `--test-reporter=@scriptc/experimental/dual-run/reporter`. */
export default function reporter(
  source: AsyncGenerator<TestEvent, void>,
): AsyncGenerator<string, void>;
