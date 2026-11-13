// Readable.from(webStream, options) evaluates the source argument before the
// options are read: from.js takes the web stream's reader, then spreads the
// options into the constructor, whose `encoding` read follows. A source-side
// update of a runtime encoding is therefore seen.
import { Readable } from "node:stream";

let encoding = "utf8";
function source(): ReadableStream<Uint8Array> {
  encoding = "latin1";
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array([0x68, 0xe9]));
      controller.close();
    },
  });
}
const stream = Readable.from(source(), { encoding: encoding as BufferEncoding });
let text = "";
stream.on("data", (chunk: string) => {
  text += chunk;
});
stream.on("end", () => console.log(JSON.stringify(text), text.length));
