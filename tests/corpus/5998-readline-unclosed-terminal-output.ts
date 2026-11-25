import * as readline from "node:readline";
import { PassThrough, Writable } from "node:stream";

// A terminal interface over a stream output that the program leaves open
// at exit. Node exits normally; a native build must release everything the
// construction registered — the input's listeners, the resumed input, and
// the 'resize' listener on the output — when the process ends.
const writes: string[] = [];
const output = new Writable({
  write(chunk: Buffer, _encoding: string, callback: () => void) {
    writes.push(chunk.toString());
    callback();
  },
});
const input = new PassThrough();
const rl = readline.createInterface({ input, output, terminal: true, prompt: "> " });
rl.on("line", (line: string) => console.log("line", JSON.stringify(line)));
input.write("hello\r");
console.log("state", JSON.stringify(rl.line), rl.cursor, input.isPaused());
output.on("resize", () => console.log("resize"));
output.emit("resize");
console.log("writes", JSON.stringify(writes));
