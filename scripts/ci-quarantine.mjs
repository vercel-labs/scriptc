// The flaky-test quarantine (tests/harness/flaky-quarantine.json): tests that failed and then passed on a rerun of
// the same tree. A quarantined test still runs in CI, but when the only failures of a CI test task
// (scripts/ci-test.mjs) are quarantined tests, the task passes with a warning instead of failing the shard. Each
// entry names its owner and an expiry date; past that date the entry no longer quarantines anything, so the test
// fails the run again until it is fixed or the entry is renewed with new evidence.
//
// The failures of a vitest process come from scripts/ci-failure-reporter.mjs, which writes them to the file that
// SCRIPTC_CI_FAILURES names. A process that ends without writing that file (killed, out of memory), or one that
// reports an error outside a test (an unhandled error, a failed hook, a file that does not load), never passes
// through the quarantine.
import { readFileSync } from "node:fs";

export const quarantinePath = new URL("../tests/harness/flaky-quarantine.json", import.meta.url);

/** The quarantine entries: `{ test, files, owner, reason, added, expires, evidence }`. */
export function loadQuarantine(path = quarantinePath) {
  return JSON.parse(readFileSync(path, "utf8")).entries;
}

/** Today's date as YYYY-MM-DD (UTC), the form of an entry's `expires`. */
export function today(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

/** The entry that quarantines a failed test `{ file, name }` on `date`, or undefined. An entry covers the test of
 * that name in each of its files; it lapses after its `expires` date. */
export function quarantineEntry(failure, entries, date = today()) {
  return entries.find(
    (entry) =>
      entry.test === failure.name && entry.files.includes(failure.file) && date <= entry.expires,
  );
}

/**
 * Whether a vitest process that exited with failures may pass: `report` is what ci-failure-reporter.mjs wrote
 * (undefined when it wrote nothing). It may pass only when it reported no error outside a test, at least one
 * failed test, and every failed test is quarantined on `date`.
 */
export function quarantineVerdict(report, entries, date = today()) {
  if (report === undefined)
    return { pass: false, quarantined: [], failed: [], other: ["no failure report"] };
  const quarantined = [];
  const failed = [];
  for (const failure of report.tests) {
    const entry = quarantineEntry(failure, entries, date);
    if (entry === undefined) failed.push(failure);
    else quarantined.push({ ...failure, entry });
  }
  const other = report.other ?? [];
  return {
    pass: other.length === 0 && failed.length === 0 && quarantined.length > 0,
    quarantined,
    failed,
    other,
  };
}

/** The entries past their expiry date on `date`. */
export function expiredEntries(entries, date = today()) {
  return entries.filter((entry) => date > entry.expires);
}
