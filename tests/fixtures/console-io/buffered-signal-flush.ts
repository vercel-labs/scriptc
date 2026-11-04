// --stdout-buffering: the parent gives this process a FIFO as stdout and does
// not read it, so the first chunk fills it. A short line stays in the buffer,
// and the next stderr write publishes that line into the full FIFO, where a
// handled signal interrupts the write before it transfers anything. The
// runtime must resume it with the bytes it had not submitted.
let interrupted = 0;
process.on("SIGTERM", () => {
  interrupted += 1;
});
process.stdout.write("a".repeat(65536));
process.stderr.write("blocking\n");
process.stdout.write("pending-line\n");
setTimeout(() => {
  // The stderr write publishes the pending line first; that write blocks on
  // the full FIFO.
  process.stderr.write("flush\n");
}, 100);
setTimeout(() => {
  process.stdout.write(`interrupted=${interrupted}\n`);
}, 900);
