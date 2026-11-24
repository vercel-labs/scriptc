// A request header block that repeats a pseudo header is a stream error of
// type PROTOCOL_ERROR in Node: the server resets the stream and no stream
// object is created. A raw peer sends the block; the server's frames and
// events are recorded.
import * as http2 from "node:http2";
import * as net from "node:net";
import type { AddressInfo } from "node:net";

const lines: string[] = [];

function frame(type: number, flags: number, streamId: number, payload: Buffer): Buffer {
  const head = Buffer.alloc(9);
  head[0] = payload.length >> 16;
  head[1] = (payload.length >> 8) & 0xff;
  head[2] = payload.length & 0xff;
  head[3] = type;
  head[4] = flags;
  head.writeUInt32BE(streamId, 5);
  return Buffer.concat([head, payload]);
}

// :method GET, :scheme http, :path "/", then :path "/" again, :authority.
const DUPLICATE_BLOCK = Buffer.concat([
  Buffer.from([0x82, 0x86, 0x84, 0x84, 0x01, 0x09]),
  Buffer.from("localhost", "latin1"),
]);

await new Promise<void>((resolve) => {
  const server = http2.createServer();
  server.on("stream", () => {
    lines.push("server stream");
  });
  server.on("session", (session) => {
    session.on("error", () => {});
  });
  server.listen(0, "127.0.0.1", () => {
    const socket = net.connect((server.address() as AddressInfo).port, "127.0.0.1");
    socket.write(Buffer.from("PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n"));
    socket.write(frame(4, 0, 0, Buffer.alloc(0)));
    setTimeout(() => socket.write(frame(1, 0x5, 1, DUPLICATE_BLOCK)), 80);
    let all = Buffer.alloc(0);
    let consumed = 0;
    socket.on("data", (chunk) => {
      all = Buffer.concat([all, chunk]);
      let off = consumed;
      while (all.length - off >= 9) {
        const len = (all[off] << 16) | (all[off + 1] << 8) | all[off + 2];
        const type = all[off + 3];
        if (all.length - off < 9 + len) break;
        if (type === 3) lines.push(`rst ${all.readUInt32BE(off + 9)}`);
        else if (type === 1) lines.push("peer headers");
        off += 9 + len;
      }
      consumed = off;
    });
    setTimeout(() => {
      socket.destroy();
      server.close(() => resolve());
    }, 400);
  });
});

for (const line of lines.sort()) console.log(line);
