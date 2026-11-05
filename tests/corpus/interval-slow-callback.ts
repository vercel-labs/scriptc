// setInterval schedules each tick from the time its callback started, as
// Node does: a callback that takes 30 ms of a 50 ms interval keeps the ticks
// 50 ms apart, and one that takes 70 ms makes the next tick due at once (70
// ms apart, not 120). Each line prints whether every gap after the first
// tick stays under a bound between those spacings and the ones a re-arm
// after the callback would give (80 and 120 ms).
function run(work: number, bound: number, done: () => void): void {
  const gaps: number[] = [];
  let last = -1;
  const interval = setInterval(() => {
    const now = performance.now();
    if (last >= 0) gaps.push(now - last);
    last = now;
    while (performance.now() - now < work) {}
    if (gaps.length === 4) {
      clearInterval(interval);
      console.log(`work ${work} ms:`, gaps.every((gap) => gap < bound));
      done();
    }
  }, 50);
}

run(30, 75, () => run(70, 110, () => console.log("done")));
