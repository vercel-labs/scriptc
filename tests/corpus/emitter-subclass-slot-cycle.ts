// A record whose field holds a Writable, with a listener on the stream that
// captures the record: record → stream → listener → record. Neither the
// record nor the stream class declares a field that closes the cycle; the
// stream's listeners come from EventEmitter, which it inherits. The
// collector has to treat the record as a possible cycle; the sanitized
// lane's RC audit fails on a leaked one.
import { Writable } from "node:stream";

interface Request {
  destination: Writable;
  written: number;
  done: boolean;
}

function render(id: number): Promise<string> {
  return new Promise((resolve) => {
    const chunks: string[] = [];
    const request: Request = {
      destination: new Writable({
        write(chunk: Buffer, _encoding, callback) {
          chunks.push(chunk.toString());
          callback();
        },
      }),
      written: 0,
      done: false,
    };
    request.destination.on("finish", () => {
      request.done = true;
      resolve(`${id}: ${chunks.join("")} (${request.written} writes, done ${request.done})`);
    });
    for (const part of ["<p>", `item ${id}`, "</p>"]) {
      request.destination.write(part);
      request.written++;
    }
    request.destination.end();
  });
}

for (let i = 0; i < 3; i++) console.log(await render(i));
