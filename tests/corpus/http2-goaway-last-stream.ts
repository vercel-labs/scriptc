// An explicit goaway() advertises a last-stream boundary; the graceful
// close that follows repeats it (RFC 9113 6.8: a later GOAWAY must not
// increase it) instead of sending 0.
import * as http2 from "node:http2";
import type { AddressInfo } from "node:net";

const lines: string[] = [];
const server = http2.createServer();
server.on("stream", (stream) => {
  stream.respond({ ":status": 200 });
  stream.write("x");
  setTimeout(() => stream.end("y"), 200);
});
server.on("session", (session) => {
  setTimeout(() => {
    session.goaway(0); // the boundary is the last processed stream (1)
    setTimeout(() => session.close(() => {}), 40);
  }, 100);
});
server.listen(0, "127.0.0.1", () => {
  const client = http2.connect(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  const lasts: number[] = [];
  client.on("goaway", (_code, last) => {
    lasts.push(last);
  });
  client.on("error", () => {});
  const request = client.request({ ":path": "/" });
  request.on("error", () => {});
  request.resume();
  request.on("end", () => lines.push("request end"));
  setTimeout(() => {
    client.destroy();
    server.close(() => {
      // every GOAWAY repeats the boundary the explicit goaway advertised
      lines.push(`goaway lasts=${[...new Set(lasts)].sort((a, b) => a - b).join(",")}`);
      for (const line of lines.sort()) console.log(line);
    });
  }, 700);
});
