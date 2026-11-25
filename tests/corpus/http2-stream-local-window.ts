// state.localWindowSize is the LOCAL receive window: the credit this side
// advertised for the peer's DATA. It does not follow the peer's advertised
// window (that is the send window) and outbound DATA does not consume it.
import * as http2 from "node:http2";
import type { AddressInfo } from "node:net";

const lines: string[] = [];

await new Promise<void>((resolve) => {
  const server = http2.createServer();
  server.on("session", (session) => {
    session.settings({ initialWindowSize: 100000 });
  });
  server.on("stream", (stream) => {
    stream.respond({ ":status": 200 });
    stream.write(Buffer.alloc(40000, 0x41));
    setTimeout(() => {
      lines.push(`server local after ack and write ${stream.state.localWindowSize}`);
      stream.end();
    }, 100);
  });
  server.listen(0, "127.0.0.1", () => {
    const client = http2.connect(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    const request = client.request({ ":path": "/" });
    request.on("response", () => {
      lines.push(`client local ${request.state.localWindowSize}`);
    });
    request.on("data", () => {});
    request.on("end", () => {
      client.close(() => {
        server.close(() => resolve());
      });
    });
    request.end();
  });
});

for (const line of lines.sort()) console.log(line);
