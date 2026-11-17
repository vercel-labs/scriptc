// process.emit(...argv) carries the values the call spread: a listener that
// grows that same array must not change what later listeners receive (the
// argument vector is its own list, as Node's spread makes one).
const err = new Error("x");
const argv = [];
argv.push("uncaughtExceptionMonitor", err);
let seen = "none";
process.on("uncaughtExceptionMonitor", () => {
  for (let i = 0; i < 100; i++) argv.push(i);
});
process.on("uncaughtExceptionMonitor", (value) => {
  seen = value === err ? "same" : "other";
});
const answered = process.emit(...argv);
console.log(answered, seen, argv.length);
