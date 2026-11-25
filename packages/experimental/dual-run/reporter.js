// @scriptc/experimental/dual-run/reporter — a node:test reporter that runs
// every test file a second way.
//
//   node --test --test-reporter=@scriptc/experimental/dual-run/reporter \
//     --test-reporter-destination=stdout
//
// Node runs the files as usual; for each file the reporter builds it with
// scriptc, runs the binary, and compares the binary's spec report, program
// output and exit code with a plain `node <file>` run of the same file,
// using the documented node:test normalization (durations, stack frames and
// the inspect property block are runner-internal and differ by design). A
// difference is reported against the test it breaks and fails the run. A
// file whose Node output itself differs between two runs is reported as
// flaky instead: the Node run, not the program, is what varies.
//
// The report is one line per file, plus the failing tests' messages and,
// on a difference, a diff. Node's own results come from the event stream
// (name, counts and message per test), so a test that fails in both lanes
// is reported as the test failure it is.

import { relative } from "node:path";
import {
  DualRunBuildError,
  compareLanes,
  describeDifferences,
  runLanes,
  runNodeLane,
} from "../dual-run-core.js";

/** How many files are compared at once. Node runs its files concurrently,
 * and each comparison is one cached build plus two short runs. */
const CONCURRENCY = 4;

/** The file Node ran that a result belongs to. A test declared in a module
 * the entry imports reports that module as `file`, with `entryFile` naming
 * the file Node started; keying by the entry keeps one line per file Node
 * ran and keeps the failure with the file that ran it. A file Node could not
 * load reports no `entryFile`, and its own path is the entry. */
function entryFileOf(data) {
  return typeof data.entryFile === "string" ? data.entryFile : data.file;
}

/** The report stream is whatever Node was told to use; the reporter only
 * yields text. */
export default async function* reporter(source) {
  const cwd = process.cwd();
  /** What Node reported about each file, keyed by its absolute path. */
  const files = new Map();
  const pending = [];
  const state = { diverged: false };

  const stateFor = (file) => {
    let fileState = files.get(file);
    if (fileState === undefined)
      files.set(file, (fileState = { summary: null, failures: [], queued: false }));
    return fileState;
  };

  /** Starts the comparison of one file, once; the entry is unknown before
   * Node reports the file done. */
  function queue(file) {
    const fileState = stateFor(file);
    if (fileState.queued) return;
    fileState.queued = true;
    pending.push(compareFile(file, fileState, cwd, state));
  }

  for await (const event of source) {
    const data = event.data;
    if (event.type === "test:fail") {
      // A suite reports its children's failure again as its own; the leaf
      // test is the one with the message.
      if (typeof data?.file !== "string" || data.details?.type === "suite") continue;
      stateFor(entryFileOf(data)).failures.push(data);
      continue;
    }
    if (event.type !== "test:summary") continue;
    // The run's own summary has no file; every file's has one.
    if (typeof data?.file !== "string") continue;
    const file = entryFileOf(data);
    stateFor(file).summary = data;
    queue(file);
    // Yield results that are already in, so a long run reports as it goes.
    while (pending.length > 0 && pending[0].settled) yield (await pending.shift().promise) + "\n";
  }
  // A file Node could not load is reported as one failed test, without a
  // summary of its own; it still ran, so it is compared like the rest.
  for (const file of files.keys()) queue(file);
  for (const entry of pending) yield (await entry.promise) + "\n";
  if (state.diverged) process.exitCode = 1;
}

/** A comparison started for one file, with a flag its result can be checked
 * against without blocking the event loop. */
function compareFile(file, fileState, cwd, state) {
  const shown = relative(cwd, file) || file;
  const entry = { settled: false };
  entry.promise = withSlot(async () => {
    try {
      return await compareOne(file, shown, fileState, cwd, state);
    } catch (error) {
      state.diverged = true;
      return `✖ ${shown}: ${error instanceof Error ? error.message : String(error)}`;
    }
  }).finally(() => {
    entry.settled = true;
  });
  return entry;
}

/** A counting semaphore around the comparisons. */
let active = 0;
const waiting = [];
async function withSlot(fn) {
  while (active >= CONCURRENCY) await new Promise((resume) => waiting.push(resume));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    waiting.shift()?.();
  }
}

async function compareOne(file, shown, fileState, cwd, state) {
  let first;
  try {
    first = await runLanes(file, { cwd });
  } catch (error) {
    state.diverged = true;
    if (error instanceof DualRunBuildError)
      return `✖ ${shown}: scriptc could not build this file\n${indent(error.stderr)}`;
    throw error;
  }
  const differences = compareLanes(first.node, first.native);
  if (differences === null) return nodeResult(shown, fileState.summary, fileState.failures);
  // The Node lane may be the side that varies: run it once more and compare
  // the two Node runs before blaming the binary.
  const again = await runNodeLane(file, { cwd });
  if (compareLanes(first.node, again) !== null)
    return `ℹ ${shown}: the Node run differs between two runs (flaky), not compared`;
  state.diverged = true;
  return `✖ ${describeDifferences(shown, differences)}`;
}

/** What Node's own run of the file reported: a line per file and a line per
 * failed test, so a test that fails in both lanes is not hidden behind a
 * passing comparison. A file Node could not load has failed tests but no
 * summary of its own, so its line carries no counts. */
function nodeResult(shown, summary, failures) {
  const counts = summary?.counts ?? {};
  const parts = [`${counts.passed ?? 0} passed`];
  if (counts.failed) parts.push(`${counts.failed} failed`);
  if (counts.skipped) parts.push(`${counts.skipped} skipped`);
  if (counts.todo) parts.push(`${counts.todo} todo`);
  const countsText = summary === null ? "" : ` (${parts.join(", ")})`;
  const head = `${summary?.success ? "✔" : "✖"} ${shown}${countsText}`;
  if (failures.length === 0) return head;
  const lines = failures.map((failure) => {
    const message = firstLine(failure.details?.error?.message);
    const where = failure.line === undefined ? "" : ` (line ${failure.line})`;
    return `  ✖ ${failure.name}: ${message}${where}`;
  });
  return [head, ...lines].join("\n");
}

/** The part of an error message that fits on a report line: the message's
 * first non-empty line, which names the failure ("Expected values to be
 * strictly deep-equal:", say); the details below it are Node's own diff. */
function firstLine(message) {
  if (typeof message !== "string") return "failed";
  const text =
    message
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line !== "") ?? "";
  if (text === "") return "failed";
  return text.length > 200 ? `${text.slice(0, 197)}...` : text;
}

function indent(text) {
  return text
    .trimEnd()
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
}
