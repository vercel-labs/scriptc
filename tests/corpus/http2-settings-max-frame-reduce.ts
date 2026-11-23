// A SETTINGS_MAX_FRAME_SIZE reduction applies only once the peer
// acknowledges it: a frame the previous, larger limit allowed is still
// accepted until then, and a frame past the new limit is refused with
// GOAWAY(FRAME_SIZE_ERROR) after the acknowledgment. A raw peer drives the
// sequence against an h2 server.
import * as http2 from "node:http2";
import * as net from "node:net";
import type { AddressInfo } from "node:net";

const lines: string[] = [];
const SETTINGS_ACK = Buffer.from([0, 0, 0, 4, 1, 0, 0, 0, 0]);
// :method GET, :scheme http, :path /, :authority "localhost".
const HEADERS = Buffer.from([0x82, 0x86, 0x84, 0x01, 0x09, 0x6c, 0x6f, 0x63, 0x61, 0x6c, 0x68, 0x6f, 0x73, 0x74]);

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

const settingsAck = (): Buffer => frame(4, 1, 0, Buffer.alloc(0));
const bigData = (): Buffer => frame(0, 0, 1, Buffer.alloc(40000, 0x41));

function maxFrameSizeOf(all: Buffer, off: number, len: number): number | null {
  for (let at = off + 9; at + 6 <= off + 9 + len; at += 6) {
    if (all.readUInt16BE(at) === 5) return all.readUInt32BE(at + 2);
  }
  return null;
}

await new Promise<void>((resolve) => {
  const server = http2.createServer();
  server.on("session", (session) => {
    session.on("error", () => {});
    setTimeout(() => session.settings({ maxFrameSize: 100000 }), 50);
    setTimeout(() => session.settings({ maxFrameSize: 16384 }), 250);
  });
  server.on("stream", (stream) => {
    stream.on("error", () => {});
    stream.resume();
  });
  server.listen(0, "127.0.0.1", () => {
    const socket = net.connect((server.address() as AddressInfo).port, "127.0.0.1");
    socket.write(Buffer.from("PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n"));
    socket.write(frame(4, 0, 0, Buffer.alloc(0)));
    let all = Buffer.alloc(0);
    let consumed = 0;
    let reduced = false;
    let sawGoaway = false;
    let finished = false;
    const finish = (): void => {
      if (finished) return;
      finished = true;
      socket.destroy();
      server.close(() => resolve());
    };
    const startReduction = (): void => {
      socket.write(frame(1, 0x4, 1, HEADERS));
      setTimeout(() => socket.write(bigData()), 80);
      setTimeout(() => {
        if (!sawGoaway) lines.push("before-ack accepted");
        socket.write(settingsAck());
      }, 300);
      setTimeout(() => socket.write(bigData()), 500);
      setTimeout(() => {
        if (sawGoaway) lines.push("after-ack goaway 6");
        finish();
      }, 900);
    };
    socket.on("data", (chunk) => {
      all = Buffer.concat([all, chunk]);
      let off = consumed;
      while (all.length - off >= 9) {
        const len = (all[off] << 16) | (all[off + 1] << 8) | all[off + 2];
        const type = all[off + 3];
        const flags = all[off + 4];
        if (all.length - off < 9 + len) break;
        if (type === 7) {
          sawGoaway = all.readUInt32BE(off + 9 + 4) === 6;
        } else if (type === 4 && (flags & 1) === 0) {
          const max = maxFrameSizeOf(all, off, len);
          if (max === 100000) {
            socket.write(settingsAck());
          } else if (max === 16384 && !reduced) {
            reduced = true;
            startReduction();
          } else if (max === null) {
            socket.write(settingsAck());
          }
        }
        off += 9 + len;
      }
      consumed = off;
    });
    setTimeout(() => finish(), 1500);
  });
});

for (const line of lines.sort()) console.log(line);
