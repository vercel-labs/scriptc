// @normalize-pid
// node:http2 stream controls: pushAllowed on a server stream whose client
// accepts pushes (the default), and priority(), which Node 24 deprecated —
// the first call warns and sends nothing, a destroyed stream throws. The
// two ends race, so the recorded lines are sorted.
import * as http2 from "node:http2";
import type { AddressInfo } from "node:net";

const lines: string[] = [];
const server = http2.createServer();
server.on("stream", (stream) => {
  lines.push(`pushAllowed ${stream.pushAllowed}`);
  stream.priority({ weight: 100 });
  stream.respond({ ":status": 200 });
  stream.end("ok");
});
server.listen(0, "127.0.0.1", () => {
  const client = http2.connect(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  client.on("connect", () => {
    const request = client.request({ ":path": "/" });
    request.on("response", (headers) => lines.push(`response ${headers[":status"]}`));
    request.on("data", (chunk) => lines.push(`data ${chunk}`));
    request.on("end", () => {
      client.close(() => {
        server.close(() => {
          for (const line of lines.sort()) console.log(line);
        });
      });
    });
    request.end();
  });
});
