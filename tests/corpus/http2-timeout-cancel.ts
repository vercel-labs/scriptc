// setTimeout(0, cb) cancels the registration the same callback made on a
// session or stream: the callback must not fire when a later timeout
// expires, and it must not stay retained. Node removes the most recent
// matching listener, so the canceled callback is silent here.
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
      const canceledSession = (): void => {
        lines.push("session canceled fired");
      };
      client.setTimeout(600000, canceledSession);
      client.setTimeout(0, canceledSession);
      client.setTimeout(10, () => {
        lines.push("session live fired");
      });
      const request = client.request({ ":path": "/" });
      const canceledStream = (): void => {
        lines.push("stream canceled fired");
      };
      request.setTimeout(600000, canceledStream);
      request.setTimeout(0, canceledStream);
      request.setTimeout(10, () => {
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
