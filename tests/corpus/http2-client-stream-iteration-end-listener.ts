// Paused mode: the async iterator is the body's only reader, and an
// 'end' listener tears the stream down while the iterator is completing.
import * as http2 from "node:http2";
import type { AddressInfo } from "node:net";

const lines: string[] = [];
const server = http2.createServer();
server.on("stream", (stream) => {
  stream.respond({ ":status": 200 });
  stream.write("a");
  stream.end();
});
server.listen(0, "127.0.0.1", () => {
  const client = http2.connect(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  client.on("error", () => {});
  const req = client.request({ ":path": "/" });
  req.on("error", () => {});
  req.on("end", () => {
    lines.push("end event");
    // cleanup that runs inside the iterator's completion
    req.destroy();
  });
  req.on("close", () => lines.push(`close rst=${req.rstCode}`));
  void (async () => {
    for await (const chunk of req) lines.push(`chunk ${(chunk as Buffer).toString()}`);
    lines.push("loop done");
    client.destroy();
    server.close(() => {
      for (const line of lines.sort()) console.log(line);
    });
  })();
});
