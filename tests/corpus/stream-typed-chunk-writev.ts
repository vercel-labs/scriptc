// writev on an object-mode Writable receives the written objects in its
// batch, with their encodings, and write() receives them one at a time.
import { Writable } from "node:stream";

type Msg = { seq: number; text: string };

const sent: Msg[] = [];
const lines: string[] = [];
const batched = new Writable({
  objectMode: true,
  write(msg: Msg, _enc, cb) {
    lines.push(`write ${msg.seq} same=${msg === sent[msg.seq]}`);
    cb();
  },
  writev(chunks: Array<{ chunk: Msg; encoding: any }>, cb) {
    const parts = chunks.map(
      (c) => `${c.chunk.seq}:${c.chunk.text}:${c.chunk === sent[c.chunk.seq]}:${String(c.encoding)}`,
    );
    lines.push(`writev ${parts.join(" ")}`);
    cb();
  },
});
const make = (seq: number): Msg => {
  const msg = { seq, text: `m${seq}` };
  sent.push(msg);
  return msg;
};
batched.write(make(0));
batched.cork();
batched.write(make(1));
batched.write(make(2));
batched.write(make(3));
process.nextTick(() => {
  batched.uncork();
  batched.end(make(4));
});
batched.on("finish", () => {
  for (const line of lines) console.log(line);
});
