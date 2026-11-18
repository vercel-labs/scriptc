// @normalize-pid
// node:http2 trailers and informational headers over real h2 streams: a
// server sends two informational HEADERS blocks (additionalHeaders), then
// its response with waitForTrailers, and the trailing block from the
// 'wantTrailers' event. sendTrailers before the stream is ready and a
// second sendTrailers both throw Node's errors. The client sees the
// informational blocks as 'headers', the final block as 'response', the
// body, and the trailing block as 'trailers'. pushAllowed is true on a
// server stream whose client accepts pushes.
import * as http2 from "node:http2";
import type { AddressInfo } from "node:net";

const serverLines: string[] = [];
const clientLines: string[] = [];

const server = http2.createServer();
server.on("stream", (stream) => {
  serverLines.push(`pushAllowed ${stream.pushAllowed}`);
  stream.priority({ weight: 100 });
  stream.additionalHeaders({ ":status": 103, "x-info": "a" });
  stream.additionalHeaders({ ":status": 100, "x-info": "b" });
  try {
    stream.sendTrailers({ "x-tr": "too-early" });
  } catch (error) {
    serverLines.push(`early ${(error as NodeJS.ErrnoException).code}`);
  }
  stream.respond({ ":status": 200, "x-res": "1" }, { waitForTrailers: true });
  serverLines.push(`headersSent ${stream.headersSent}`);
  stream.on("wantTrailers", () => {
    serverLines.push("wantTrailers");
    stream.sendTrailers({ "x-tr": "t1" });
    try {
      stream.sendTrailers({ "x-tr": "t2" });
    } catch (error) {
      serverLines.push(`second ${(error as NodeJS.ErrnoException).code}`);
    }
  });
  stream.end("body");
});
server.listen(0, "127.0.0.1", () => {
  const client = http2.connect(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  client.on("connect", () => {
    const request = client.request({ ":path": "/" });
    request.on("headers", (headers) => clientLines.push(`headers ${headers[":status"]} ${headers["x-info"]}`));
    request.on("response", (headers) => clientLines.push(`response ${headers[":status"]} ${headers["x-res"]}`));
    request.on("data", (chunk) => clientLines.push(`data ${chunk}`));
    request.on("trailers", (trailers) => clientLines.push(`trailers ${trailers["x-tr"]}`));
    request.on("end", () => {
      client.close(() =>
        server.close(() => {
          for (const line of serverLines) console.log(`server ${line}`);
          for (const line of clientLines) console.log(`client ${line}`);
        }),
      );
    });
    request.end();
  });
});
