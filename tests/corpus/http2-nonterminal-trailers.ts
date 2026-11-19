// A peer that keeps sending non-terminal HEADERS blocks on one request must
// not grow anything the request keeps: HTTP/2 trailers are the stream's
// FINAL HEADERS block, so the server resets the stream with RST_STREAM
// PROTOCOL_ERROR and stores no trailer fields. The raw client speaks the
// frames itself so the extra blocks are exactly what it sends, and both
// sides only report what is visible in that flow.
import * as http2 from "node:http2";
import * as net from "node:net";
import type { AddressInfo } from "node:net";

const lines: string[] = [];

const server = http2.createServer((request, response) => {
  request.resume();
  request.on("close", () => lines.push(`server trailers ${Object.keys(request.trailers).length}`));
  response.end("ok");
});
server.on("stream", (stream) =>
  stream.on("error", (error: NodeJS.ErrnoException) => lines.push(`server error ${error.message}`)),
);

/** One HPACK literal field, never indexed, no Huffman: name and value. */
function field(name: string, value: string): Buffer {
  const n = Buffer.from(name);
  const v = Buffer.from(value);
  return Buffer.concat([Buffer.from([0, n.length]), n, Buffer.from([v.length]), v]);
}

/** A HEADERS frame on stream 1 with the given block bytes and flags. */
function headers(flags: number, fields: Buffer[]): Buffer {
  const block = Buffer.concat(fields);
  return Buffer.concat([Buffer.from([0, 0, block.length, 1, flags, 0, 0, 0, 1]), block]);
}

await new Promise<void>((resolve) => {
  server.listen(0, "127.0.0.1", () => {
    const socket = net.connect((server.address() as AddressInfo).port, "127.0.0.1", () => {
      socket.write(Buffer.from("PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n"));
      socket.write(Buffer.from([0, 0, 0, 4, 0, 0, 0, 0, 0])); // an empty SETTINGS
      socket.write(
        headers(4, [
          field(":method", "GET"),
          field(":path", "/"),
          field(":scheme", "http"),
          field(":authority", "127.0.0.1"),
        ]),
      );
      // sixty-four trailer-sized blocks that do not end the stream
      for (let i = 0; i < 64; i++) socket.write(headers(4, [field("x-t", "0123456789abcdef")]));
    });
    // walk the server's frames: an RST_STREAM on stream 1 with PROTOCOL_ERROR
    let pending = Buffer.from("");
    let reset = 0;
    let settled = false;
    const settle = (): void => {
      if (settled) return;
      settled = true;
      lines.push(`raw reset ${reset}`);
      socket.destroy();
      server.close(() => resolve());
    };
    socket.on("data", (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= 9) {
        const length = (pending[0] << 16) | (pending[1] << 8) | pending[2];
        if (pending.length < 9 + length) break;
        if (pending[3] === 3 && ((pending[5] & 0x7f) << 24 | pending[6] << 16 | pending[7] << 8 | pending[8]) === 1) {
          reset = pending[9] << 24 | pending[10] << 16 | pending[11] << 8 | pending[12];
          if (!settled) setTimeout(settle, 50);
        }
        pending = pending.subarray(9 + length);
      }
    });
    socket.on("error", () => {});
    setTimeout(settle, 2000);
  });
});

for (const line of lines.sort()) console.log(line);
