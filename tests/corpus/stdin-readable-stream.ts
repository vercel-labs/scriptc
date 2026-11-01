// The typed process.stdin stream surface against the empty closed stream the
// harness provides: a 'readable' listener pins paused mode (resume() does not
// flip isPaused() back), read() answers null at EOF, readableLength stays 0,
// and 'end' fires after the drained 'readable'. The piped-data half lives in
// the event-loop harness, which controls what flows in.
console.log("initial", process.stdin.isPaused(), process.stdin.readableLength, process.stdin.read());

process.stdin.on("readable", () => {
  const chunk = process.stdin.read();
  console.log("readable", chunk === null, process.stdin.readableLength, process.stdin.isPaused());
});

process.stdin.on("end", () => {
  console.log("end", process.stdin.read() === null, process.stdin.readableLength);
});

setTimeout(() => {
  process.stdin.pause();
  console.log("paused", process.stdin.isPaused());
  process.stdin.resume();
  console.log("resumed", process.stdin.isPaused());
}, 20);
