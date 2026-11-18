// node:http2 session lifecycle members over real h2 connections:
// goaway() with an error code, a last stream id and opaque data (the peer
// hears the code and id on 'goaway'), ref()/unref(), setLocalWindowSize()
// with its range errors, and the ERR_HTTP2_INVALID_SESSION goaway()
// throws on a destroyed session. Both ends race, so the recorded lines
// are sorted.
import * as http2 from "node:http2";
import type { AddressInfo } from "node:net";

const lines: string[] = [];
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

await new Promise<void>((resolve) => {
  const server = http2.createServer();
  server.on("session", (session) => {
    session.on("goaway", (code, lastStreamID) => {
      lines.push(`goaway ${code} ${lastStreamID}`);
    });
  });
  server.listen(0, "127.0.0.1", () => {
    const client = http2.connect(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    client.on("connect", () => {
      client.goaway(0, 0, Buffer.from([0xde, 0xad]));
      client.goaway(0, 1);
      client.unref();
      client.ref();
      void delay(100).then(() => {
        client.close(() => server.close(() => resolve()));
      });
    });
  });
});

await new Promise<void>((resolve) => {
  const server = http2.createServer();
  server.listen(0, "127.0.0.1", () => {
    const client = http2.connect(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    client.on("connect", () => {
      client.setLocalWindowSize(100000);
      for (const value of [-1, 1.5]) {
        try {
          client.setLocalWindowSize(value);
        } catch (error) {
          lines.push(`window ${(error as NodeJS.ErrnoException).code}`);
        }
      }
      client.destroy();
      client.setTimeout(0);
      try {
        client.goaway();
      } catch (error) {
        lines.push(`destroyed ${(error as NodeJS.ErrnoException).code}`);
      }
      server.close(() => resolve());
    });
  });
});

for (const line of lines.sort()) console.log(line);
