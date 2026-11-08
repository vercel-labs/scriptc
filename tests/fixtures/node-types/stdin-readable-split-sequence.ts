// process.stdin with an encoding set, also received as a Readable, while
// characters arrive split across reads. The string listener gets each
// character whole, and the stream gets every byte: a read that holds only
// the first bytes of a character is no 'data' event for the string
// listener, and its bytes are not lost to the stream. The stream is
// process.stdin itself and hands out the decoded strings; where its pieces
// end depends on the reads, so the program compares bytes, not pieces.
import type { Readable } from "node:stream";

function collect(stream: Readable, done: (hex: string) => void): void {
  const pieces: Buffer[] = [];
  stream.on("data", (chunk: string | Buffer) => {
    pieces.push(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk);
  });
  stream.on("end", () => done(Buffer.concat(pieces).toString("hex")));
}

let text = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  text += chunk;
});
collect(process.stdin, (hex) => {
  console.log(JSON.stringify(text), hex);
});
