// try/catch discharges NoThrow: a throwing call inside a `try` whose
// `catch` takes every exception, or whose `finally` never completes
// normally, cannot propagate. finally ordering and rethrows stay exact.
import type { NoThrow } from "@scriptc/types";

class Stats {
  caught = 0;
  finals = 0;
  // Logging in catch/finally must itself be NoThrow; array pushes can refuse.
  events = "";
}

function parseDigit(ch: number): number {
  if (ch < 48 || ch > 57) throw new RangeError(`not a digit: ${ch}`);
  return ch - 48;
}

function digitOr(text: string, i: number, fallback: number): NoThrow<number> {
  try {
    return parseDigit(text.charCodeAt(i));
  } catch {
    return fallback;
  }
}

function logged(text: string, stats: Stats): NoThrow<number> {
  try {
    stats.events += `try ${text}\n`;
    return parseDigit(text.charCodeAt(0));
  } catch (error) {
    stats.events += (error instanceof RangeError ? "catch RangeError" : "catch other") + "\n";
    stats.caught++;
    return -1;
  } finally {
    stats.events += "finally\n";
    stats.finals++;
  }
}

// The catch rethrows, but the finally returns, which discards the exception.
function swallowed(text: string, stats: Stats): NoThrow<number> {
  try {
    return parseDigit(text.charCodeAt(0));
  } catch (error) {
    stats.caught++;
    throw error;
  } finally {
    stats.finals++;
    // eslint-disable-next-line no-unsafe-finally
    return -2;
  }
}

// An inner finally re-raises; the outer catch takes it.
function nested(text: string, stats: Stats): NoThrow<number> {
  try {
    try {
      return parseDigit(text.charCodeAt(0)) * 10;
    } finally {
      stats.events += "inner finally\n";
    }
  } catch {
    stats.events += "outer catch\n";
    return -3;
  }
}

// Node's own TypeError from reading a property of undefined is caught too.
function lengthAt(items: (string | undefined)[], i: number): NoThrow<number> {
  try {
    return items[i]!.length;
  } catch {
    return -4;
  }
}

// Without NoThrow, a finally that completes normally keeps propagating.
function propagates(text: string, stats: Stats): number {
  try {
    return parseDigit(text.charCodeAt(0));
  } finally {
    stats.events += `propagates finally ${text}\n`;
  }
}

const stats = new Stats();
for (const text of ["7", "x", "", "42"]) {
  console.log(text, digitOr(text, 0, -9), logged(text, stats), swallowed(text, stats), nested(text, stats));
}
const items: (string | undefined)[] = ["ab", undefined, "cde"];
console.log(lengthAt(items, 0), lengthAt(items, 1), lengthAt(items, 2));
for (const text of ["3", "?"]) {
  try {
    console.log("propagates", propagates(text, stats));
  } catch (error) {
    console.log("escaped", error instanceof RangeError, (error as Error).message);
  }
}
console.log(stats.caught, stats.finals);
console.log(stats.events.slice(0, -1));
