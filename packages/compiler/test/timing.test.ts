import { expect, test } from "vitest";
import { compilationTiming, timingProcessMetrics } from "../src/timing.js";

/** The lines `write` collected while `run` wrote to stderr. */
function capture(run: () => void): string[] {
  const lines: string[] = [];
  const original = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    lines.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stderr.write;
  try {
    run();
  } finally {
    process.stderr.write = original;
  }
  return lines;
}

test("a timing line reports peak RSS and CPU time", () => {
  const previous = process.env["SCRIPTC_TIMING"];
  process.env["SCRIPTC_TIMING"] = "1";
  try {
    const lines = capture(() => {
      const timing = compilationTiming();
      timing("prepare");
      timing("emit", { functions: 3 });
    });
    const events = lines.map(
      (line) => JSON.parse(line.slice("scriptc timing ".length)) as Record<string, unknown>,
    );
    expect(events.map((event) => event.phase)).toEqual(["prepare", "emit"]);
    for (const event of events) {
      expect(typeof event.rss_mb).toBe("number");
      expect(Number.isInteger(event.rss_mb)).toBe(true);
      expect(event.rss_mb).toBeGreaterThan(0);
      expect(typeof event.cpu_ms).toBe("number");
      expect(Number.isInteger(event.cpu_ms)).toBe(true);
      expect(event.cpu_ms).toBeGreaterThanOrEqual(0);
    }
    // A phase reports the process's totals so far: CPU time never goes back.
    expect(events[1]!.cpu_ms as number).toBeGreaterThanOrEqual(events[0]!.cpu_ms as number);
    expect(events[1]!.functions).toBe(3);
  } finally {
    if (previous === undefined) delete process.env["SCRIPTC_TIMING"];
    else process.env["SCRIPTC_TIMING"] = previous;
  }
});

test("a frontend process continues its parent's wall clock but keeps its own metrics", () => {
  const previous = process.env["SCRIPTC_TIMING"];
  process.env["SCRIPTC_TIMING"] = "1";
  try {
    const lines = capture(() => {
      const timing = compilationTiming({ start: Date.now() - 5000, previous: Date.now() - 1000 });
      timing("frontend-load");
    });
    const event = JSON.parse(lines[0]!.slice("scriptc timing ".length)) as Record<string, unknown>;
    // The parent's clock makes the phase at least a second long...
    expect(event.phase_ms as number).toBeGreaterThanOrEqual(1000);
    // ...while the metrics describe this process, not the parent's.
    expect(event.cpu_ms as number).toBeLessThan(60_000);
  } finally {
    if (previous === undefined) delete process.env["SCRIPTC_TIMING"];
    else process.env["SCRIPTC_TIMING"] = previous;
  }
});

test("the disabled path writes nothing and reads nothing", () => {
  const previous = process.env["SCRIPTC_TIMING"];
  delete process.env["SCRIPTC_TIMING"];
  try {
    const lines = capture(() => compilationTiming()("prepare"));
    expect(lines).toEqual([]);
  } finally {
    if (previous !== undefined) process.env["SCRIPTC_TIMING"] = previous;
  }
});

test("process metrics are integers in MiB and milliseconds", () => {
  const metrics = timingProcessMetrics();
  expect(Object.keys(metrics).sort()).toEqual(["cpu_ms", "rss_mb"]);
  expect(Number.isInteger(metrics.rss_mb)).toBe(true);
  expect(metrics.rss_mb).toBeGreaterThan(0);
  expect(Number.isInteger(metrics.cpu_ms)).toBe(true);
  expect(metrics.cpu_ms).toBeGreaterThanOrEqual(0);
});
