// The client validates a received block the way nghttp2 does before Node
// surfaces anything: a response block needs one three-digit :status and no
// other pseudo-header, a trailer block none at all, and both keep the
// regular-field rules (lowercase names, no connection-specific field). A
// malformed block is RST_STREAM(PROTOCOL_ERROR) and the stream reports
// ERR_HTTP2_STREAM_ERROR — no response, trailers or end event. The peer here
// is a raw socket so the blocks are exactly what it sends.
import * as http2 from "node:http2";
import * as net from "node:net";
import type { AddressInfo } from "node:net";

/** One HPACK literal field, never indexed, no Huffman: name and value. */
function field(name: string, value: string): Buffer {
  const n = Buffer.from(name);
  const v = Buffer.from(value);
  return Buffer.concat([Buffer.from([0, n.length]), n, Buffer.from([v.length]), v]);
}

/** A frame on stream 1: 24-bit length, type, flags, stream id, block. */
function frame(type: number, flags: number, fields: Buffer[]): Buffer {
  const block = fields.length > 0 ? Buffer.concat(fields) : Buffer.alloc(0);
  return Buffer.concat([
    Buffer.from([(block.length >> 16) & 0xff, (block.length >> 8) & 0xff, block.length & 0xff, type, flags]),
    Buffer.from([0, 0, 0, 1]),
    block,
  ]);
}

const SETTINGS = Buffer.from([0, 0, 0, 4, 0, 0, 0, 0, 0]); // an empty SETTINGS (stream 0)
const RESP_200 = frame(1, 4, [field(":status", "200")]);
const BODY = frame(0, 0, [Buffer.from("ok")]);
const TRAILERS_OK = frame(1, 5, [field("x-t", "1")]);
const RESP_CONNECTION = frame(1, 4, [field(":status", "200"), field("connection", "close")]);
const RESP_PSEUDO = frame(1, 4, [field(":status", "200"), field(":path", "/x")]);
const TRAILERS_PSEUDO = frame(1, 5, [field(":path", "/evil")]);

const CASES: [string, Buffer[]][] = [
  ["connection", [RESP_CONNECTION]],
  ["pseudo", [RESP_PSEUDO]],
  ["trailer", [RESP_200, BODY, TRAILERS_PSEUDO]],
  ["valid", [RESP_200, BODY, TRAILERS_OK]],
];

const PREFACE = "PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n";

function runCase(label: string, frames: Buffer[]): Promise<void> {
  return new Promise<void>((resolve) => {
    const lines: string[] = [];
    const server = net.createServer((sock) => {
      let pending = Buffer.alloc(0);
      let answered = false;
      sock.on("data", (chunk: Buffer) => {
        pending = Buffer.concat([pending, chunk]);
        if (pending.length < 24 || pending.subarray(0, 24).toString("latin1") !== PREFACE) return;
        let off = 24;
        while (pending.length >= off + 9) {
          const length = (pending[off] << 16) | (pending[off + 1] << 8) | pending[off + 2];
          if (pending.length < off + 9 + length) return;
          const type = pending[off + 3];
          off += 9 + length;
          if (type === 1 && !answered) {
            answered = true;
            sock.write(Buffer.concat(frames));
            return;
          }
        }
      });
      sock.write(SETTINGS);
      sock.on("error", () => {});
    });
    server.listen(0, "127.0.0.1", () => {
      const client = http2.connect(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
      client.on("error", () => {});
      const request = client.request({ ":path": "/" });
      request.on("response", (headers) => lines.push(`response ${headers[":status"]}`));
      request.on("data", (chunk: Buffer) => lines.push(`data ${chunk.toString("utf8")}`));
      request.on("trailers", (trailers: Record<string, unknown>) => lines.push(`trailers ${trailers["x-t"]}`));
      request.on("end", () => lines.push("end"));
      request.on("error", (error: NodeJS.ErrnoException) => lines.push(`error ${error.code}`));
      request.on("close", () => {
        client.close();
        server.close(() => {
          for (const line of lines) console.log(label, line);
          resolve();
        });
      });
      request.end();
    });
  });
}

for (const [label, frames] of CASES) await runCase(label, frames);
