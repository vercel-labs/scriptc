// rl.cursor answers undefined on an interface that is not a terminal and
// the cursor position on a terminal interface.
import * as readline from "node:readline";
import { PassThrough, Writable } from "node:stream";

const input = new PassThrough();
const rl = readline.createInterface({ input });
const c = rl.cursor;
console.log("cursor", c, typeof rl.cursor, rl.cursor === undefined);
console.log("arithmetic", rl.cursor + 1, Number.isNaN(rl.cursor * 2));
console.log("fallback", rl.cursor ?? -1, `${rl.cursor}`);

const interfaces = [rl];
function first(): readline.Interface {
  return interfaces[0]!;
}
console.log("call receiver", first().cursor);
rl.close();

const sink = new Writable({
  write(_chunk: Buffer, _enc, cb) {
    cb();
  },
});
const terminal = readline.createInterface({ input: new PassThrough(), output: sink, terminal: true });
terminal.write("abc");
console.log("terminal", terminal.cursor, typeof terminal.cursor, terminal.cursor + 1);
terminal.close();
