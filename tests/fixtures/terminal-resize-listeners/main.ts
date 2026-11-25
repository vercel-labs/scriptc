// 'resize' listeners on terminal streams held as values: on, once and a
// removed listener, on stdout and stderr, across two resizes; then a write
// with a completion callback ends the program.
import type { WriteStream } from "node:tty";

const seen: string[] = [];
let finished = 0;
function watch(panel: WriteStream, label: string, done: () => void): void {
  let rounds = 0;
  const first = () => seen.push(`${label}:once:${panel.columns}x${panel.rows}`);
  const removed = () => seen.push(`${label}:removed`);
  const always = () => {
    seen.push(`${label}:on:${panel.columns}x${panel.rows}`);
    if (++rounds === 2) {
      panel.removeListener("resize", always);
      done();
    }
  };
  panel.once("resize", first);
  panel.on("resize", removed);
  panel.on("resize", always);
  panel.removeListener("resize", removed);
}
let reported = 0;
const guard = setInterval(() => {
  // One line per resize round, once both streams have seen it.
  if (seen.length >= 4 && reported === 0) {
    reported = 1;
    console.log(JSON.stringify(seen));
  }
}, 5);
const limit = setTimeout(() => {
  clearInterval(guard);
  process.exitCode = 1;
}, 8000);
function done(): void {
  if (++finished < 2) return;
  clearInterval(guard);
  clearTimeout(limit);
  const out: WriteStream = process.stdout;
  out.write(JSON.stringify(seen) + "\n", (problem) => {
    console.log(JSON.stringify(["flushed", problem === null]));
  });
}
watch(process.stdout, "out", done);
watch(process.stderr, "err", done);
// The observer resizes the terminals when it reads this line, so the
// listeners are registered first.
console.log(JSON.stringify(["ready", process.stdout.isTTY === true, process.stderr.isTTY === true]));
