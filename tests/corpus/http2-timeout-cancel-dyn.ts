// setTimeout(0, cb) cancels the registration the same callback made on a
// checked-dynamic session or stream too: the dynamic listener adapter is
// unwrapped to the callback the registration stored, so the canceled
// callback neither fires when a later timeout expires nor stays retained.
import * as http2 from "node:http2";
import type { AddressInfo } from "node:net";

const lines: string[] = [];

await new Promise<void>((resolve) => {
  const server = http2.createServer();
  server.on("stream", (stream) => {
    setTimeout(() => {
      stream.respond({ ":status": 200 });
      stream.end("ok");
    }, 300);
  });
  server.listen(0, "127.0.0.1", () => {
    const client = http2.connect(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    client.on("connect", () => {
      const session: any = client;
      const canceledSession = (): void => {
        lines.push("session canceled fired");
      };
      session.setTimeout(600000, canceledSession);
      session.setTimeout(0, canceledSession);
      session.setTimeout(10, () => {
        lines.push("session live fired");
      });
      const request = client.request({ ":path": "/" });
      const stream: any = request;
      const canceledStream = (): void => {
        lines.push("stream canceled fired");
      };
      stream.setTimeout(600000, canceledStream);
      stream.setTimeout(0, canceledStream);
      stream.setTimeout(10, () => {
        lines.push("stream live fired");
      });
      request.resume();
      request.on("end", () => {
        setTimeout(() => {
          client.close(() => {
            server.close(() => resolve());
          });
        }, 50);
      });
      request.end();
    });
  });
});

for (const line of lines.sort()) console.log(line);
