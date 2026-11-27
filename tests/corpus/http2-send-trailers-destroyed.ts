// sendTrailers on a stream that was destroyed answers ERR_HTTP2_INVALID_STREAM
// before the already-sent state: Node's destroyed check comes first.
import * as http2 from "node:http2";
import type { AddressInfo } from "node:net";

const lines: string[] = [];
const server = http2.createServer();
server.on("stream", (stream) => {
  stream.respond({ ":status": 200 }, { waitForTrailers: true });
  stream.on("wantTrailers", () => {
    const send = (label: string) => {
      try {
        stream.sendTrailers({ "x-e": "5" });
        lines.push(`${label} ok`);
      } catch (error) {
        const e = error as Error & { code?: string };
        lines.push(`${label} ${e.code ?? "-"} ${e.message}`);
      }
    };
    send("first");
    stream.destroy();
    send("destroyed");
  });
  stream.end("body");
});
server.listen(0, "127.0.0.1", () => {
  const client = http2.connect(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  const request = client.request({ ":path": "/" });
  request.on("error", () => {});
  request.resume();
  request.on("end", () => {
    client.destroy();
    server.close(() => {
      for (const line of lines) console.log(line);
    });
  });
});
