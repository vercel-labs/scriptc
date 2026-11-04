// --stdout-buffering: a SIGKILL that arrives while the program is spinning
// (no event-loop turn, no exit path) leaves the unsettled bytes in the
// buffer. The argument names how many 40-byte lines to write first.
const total = Number(process.argv[2] ?? "0");
const line = `${"x".repeat(39)}\n`;
let written = 0;
while (written < total) {
  process.stdout.write(line);
  written += line.length;
}
// Busy-wait: the parent kills this process before the loop gets a turn.
const until = Date.now() + 5000;
while (Date.now() < until) {
  // spin
}
