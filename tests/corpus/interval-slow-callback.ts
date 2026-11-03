// setInterval schedules each tick from the time its callback started, as
// Node does: a callback that takes 150 ms of a 200 ms interval keeps the
// ticks 200 ms apart, and one longer than the interval makes the next tick
// due at once (the gap is the callback's own duration, not that duration
// plus an interval). Each line prints whether the smallest gap after the
// first tick stayed under a bound between those two spacings. The smallest,
// and not every gap, because a loaded runner can only delay a wakeup: the
// two behaviors stay one interval apart (75 ms and 100 ms here), so a single
// late tick on either side does not decide the comparison.
function run(work: number, bound: number, done: () => void): void {
  const gaps: number[] = [];
  let last = -1;
  const interval = setInterval(() => {
    const now = performance.now();
    if (last >= 0) gaps.push(now - last);
    last = now;
    const until = now + work;
    while (performance.now() < until) {}
    if (gaps.length === 2) {
      clearInterval(interval);
      console.log(`work ${work} ms:`, Math.min(...gaps) < bound);
      done();
    }
  }, 200);
}

run(150, 275, () => run(320, 420, () => console.log("done")));
