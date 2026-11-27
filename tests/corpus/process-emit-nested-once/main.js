// A listener that emits the same event reaches the remaining listeners
// again in Node, but a once listener fires once: Node's once wrapper is a
// no-op after it runs, so the outer snapshot must not run it a second time.
let runs = 0;
let nested = false;
process.on("SIGTSTP", () => {
  if (!nested) {
    nested = true;
    process.emit("SIGTSTP");
  }
});
process.once("SIGTSTP", () => {
  runs++;
});
process.emit("SIGTSTP");
console.log("runs", runs);
