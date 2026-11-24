import { readFileSync } from "node:fs";

export type CompilationTiming = (phase: string, detail?: Record<string, unknown>) => void;

/** The start of a timing and its latest phase, as `Date.now()` values. */
export interface TimingClock {
  start: number;
  previous: number;
}

/** What every timing line reports about the process that wrote it: its peak
 * resident set size in MiB and the CPU time it has used in milliseconds. */
export interface TimingProcessMetrics {
  rss_mb: number;
  cpu_ms: number;
}

/** The largest resident set size the process has had, in bytes. The OS keeps
 * the high-water mark on Linux; elsewhere this is the largest sample taken
 * at a timing line, which is where a build's memory peaks. */
let peakRssBytes = 0;

/** The process's peak resident set size in bytes: the kernel's high-water
 * mark (`VmHWM`) when it reports one, else the largest sampled value. */
function readPeakRssBytes(): number {
  const rss = process.memoryUsage().rss;
  if (rss > peakRssBytes) peakRssBytes = rss;
  try {
    const status = readFileSync("/proc/self/status", "utf8");
    const match = /^VmHWM:\s+(\d+) kB$/m.exec(status);
    if (match !== null) {
      const highWater = Number(match[1]) * 1024;
      if (highWater > peakRssBytes) peakRssBytes = highWater;
    }
  } catch {
    // Not Linux, or /proc is unavailable: the sampled maximum stands.
  }
  return peakRssBytes;
}

/** Peak resident set size in whole MiB and cumulative CPU time in whole
 * milliseconds (user plus system) for the process writing the line. A
 * frontend process reports its own values, as the phases it timed ran there. */
export function timingProcessMetrics(): TimingProcessMetrics {
  const cpu = process.cpuUsage();
  return {
    rss_mb: Math.round(readPeakRssBytes() / (1024 * 1024)),
    cpu_ms: Math.round((cpu.user + cpu.system) / 1000),
  };
}

/** Opt-in phase durations shared by the Node seed and native compiler.
 * The disabled path does not read the clock or write compiler output.
 * With `clock`, the phases continue a timing that started in another
 * process, so a frontend process reports them as its parent compile would. */
export function compilationTiming(clock?: TimingClock): CompilationTiming {
  if (process.env["SCRIPTC_TIMING"] !== "1") return () => {};
  const opened = performance.now();
  const start = clock === undefined ? opened : opened - (Date.now() - clock.start);
  let previous = clock === undefined ? start : opened - (Date.now() - clock.previous);
  return (phase, detail = {}) => {
    const now = performance.now();
    process.stderr.write(
      `scriptc timing ${JSON.stringify({
        phase,
        phase_ms: Math.round((now - previous) * 10) / 10,
        total_ms: Math.round((now - start) * 10) / 10,
        ...timingProcessMetrics(),
        ...detail,
      })}\n`,
    );
    previous = now;
  };
}
