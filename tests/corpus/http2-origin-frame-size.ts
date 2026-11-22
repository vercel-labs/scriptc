// An inbound frame larger than the SETTINGS_MAX_FRAME_SIZE this side
// advertised (16384 by default) is a connection error: the payload is never
// buffered, the session reports its error, and the peer is answered with
// GOAWAY(FRAME_SIZE_ERROR), as Node does. The raw peer records the GOAWAY it
// receives; both ends race, so the lines are sorted.
import * as http2 from "node:http2";
import * as net from "node:net";
import type { AddressInfo } from "node:net";

const lines: string[] = [];

// An empty SETTINGS frame, then a 20000-byte DATA frame on stream 1.
const SETTINGS = Buffer.from([0, 0, 0, 4, 0, 0, 0, 0, 0]);
const OVERSIZED = Buffer.concat([
  Buffer.from([0x00, 0x4e, 0x20, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01]),
  Buffer.alloc(20000, 0x41),
]);

await new Promise<void>((resolve) => {
  const server = net.createServer((socket) => {
    let all = Buffer.alloc(0);
    let consumed = 0;
    let prefaceDone = false;
    socket.write(SETTINGS);
    socket.on("data", (chunk) => {
      all = Buffer.concat([all, chunk]);
      if (!prefaceDone) {
        if (all.length < 24) return;
        prefaceDone = true;
        consumed = 24;
      }
      let off = consumed;
      while (all.length - off >= 9) {
        const length = (all[off] << 16) | (all[off + 1] << 8) | all[off + 2];
        if (all.length - off < 9 + length) break;
        if (all[off + 3] === 7) lines.push(`goaway ${all.readUInt32BE(off + 9 + 4)}`);
        off += 9 + length;
      }
      consumed = off;
    });
    setTimeout(() => socket.write(OVERSIZED), 100);
    setTimeout(() => socket.end(), 300);
  });
  server.listen(0, "127.0.0.1", () => {
    const client = http2.connect(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    client.on("error", () => {
      lines.push("error");
    });
    client.on("close", () => {
      server.close(() => resolve());
    });
    setTimeout(() => client.destroy(), 600);
  });
});

for (const line of lines.sort()) console.log(line);
