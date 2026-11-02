// Typed twin of stdio-pause-resume: flowing mode through a typed 'data'
// listener, pause() inside the first chunk, resume() on a timer. The output
// is chunk-boundary independent: the reassembled text and the isPaused()
// answers, never the chunk count.
const input = process.stdin;
const parts: string[] = [];
let events = 0;
let checks = true;
console.log("initial", input.isPaused());
input.on("data", (chunk: Uint8Array) => {
  parts.push(Buffer.from(chunk).toString("ascii"));
  events++;
  if (events === 1) {
    input.pause();
    if (!input.isPaused()) checks = false;
    setTimeout(() => {
      if (!input.isPaused()) checks = false;
      input.resume();
      if (input.isPaused()) checks = false;
    }, 20);
  }
});
input.on("end", () => {
  console.log("paused checks", checks);
  console.log("text", parts.join(""));
  console.log("len", parts.join("").length, input.readableLength);
});
