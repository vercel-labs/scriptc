// process.stdin received as a Readable piped into process.stdout received as
// a Writable: the pipe copies the input and leaves process.stdout open.
import type { Readable, Writable } from "node:stream";

function copy(from: Readable, to: Writable, done: () => void): void {
  from.on("end", done);
  from.pipe(to);
}
copy(process.stdin, process.stdout, () => {
  setTimeout(() => {
    console.log("copied; stdout still writable:", process.stdout.write(""));
  }, 20);
});
