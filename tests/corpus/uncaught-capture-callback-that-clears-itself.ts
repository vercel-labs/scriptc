// An uncaught exception capture callback that clears itself while it runs:
// the callback keeps running with the state it captured, as in Node, and
// the next uncaught exception finds no callback.
function install(label: string): void {
  const seen: string[] = [label];
  const counts = { calls: 0 };
  process.setUncaughtExceptionCaptureCallback((error: unknown) => {
    process.setUncaughtExceptionCaptureCallback(null);
    counts.calls += 1;
    seen.push(String((error as Error).message));
    const filler: string[] = [];
    for (let i = 0; i < 64; i++) filler.push("x".repeat(i));
    console.log(seen.join(" "), counts.calls, filler.length);
    console.log("cleared", process.hasUncaughtExceptionCaptureCallback());
  });
}

install("captured");
setTimeout(() => {
  throw new Error("first");
}, 0);
setTimeout(() => {
  install("again");
  console.log("installed", process.hasUncaughtExceptionCaptureCallback());
}, 5);
setTimeout(() => {
  throw new Error("second");
}, 10);
setTimeout(() => console.log("after"), 15);
