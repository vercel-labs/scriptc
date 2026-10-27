export type CompilationTiming = (phase: string, detail?: Record<string, unknown>) => void;

/** The start of a timing and its latest phase, as `Date.now()` values. */
export interface TimingClock {
  start: number;
  previous: number;
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
        ...detail,
      })}\n`,
    );
    previous = now;
  };
}
