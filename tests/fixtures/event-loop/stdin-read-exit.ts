// read() alone keeps the loop on stdin until end-of-input: the read ahead
// is in flight, so input the pipe held is still in the stream at exit.
// Without the loop the process exits before any of it arrives.
const first = process.stdin.read();
process.on("exit", () => {
  console.log("first", first === null);
  console.log("held at exit", process.stdin.readableLength);
});
