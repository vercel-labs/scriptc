// The stdout reader goes away while console.log is still writing. With
// SIGPIPE ignored (Node always ignores it), the failed writes surface as
// EPIPE, the global console ignores stream errors, and the program runs to
// completion: the stderr line and exit status must match Node.
let total = 0;
for (let i = 0; i < 50000; i++) {
  console.log("line", i, "of the stream that loses its reader");
  total += i;
}
console.error("done", total);
