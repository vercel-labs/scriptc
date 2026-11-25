// --stdout-buffering: with nothing but a timer pending, the loop sleeps in
// its plain timer arm. The line written before the sleep must be published
// before it starts, or a reader waits out the whole timer for it.
process.stdout.write("before-sleep\n");
setTimeout(() => {
  process.stdout.write("after-sleep\n");
}, 400);
