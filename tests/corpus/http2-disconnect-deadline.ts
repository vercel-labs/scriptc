// A peer that opens an HTTP/2 connection, sends the connection preface and
// only part of a frame, then disappears. With the server's long idle
// deadline armed, the closed session must not keep the session (or its
// receive buffers) alive: the deadline is the transport's and goes with it.
// The next client is served normally. The lines are printed sorted.
import * as http2 from "node:http2";
import * as net from "node:net";
import type { AddressInfo } from "node:net";

const lines: string[] = [];
const server = http2.createServer();
server.setTimeout(60000); // a session leaked past its transport would sit here
server.on("session", () => lines.push("server session"));
server.on("stream", (stream) => {
  stream.respond({ ":status": 200 });
  stream.end("ok");
});

/** The partial-frame peer: preface, half a DATA frame header, then gone. */
function abortivePeer(port: number): Promise<void> {
  return new Promise((resolve) => {
    const socket = net.connect(port, "127.0.0.1", () => {
      socket.write("PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n", () => {
        // a DATA frame header promising sixteen bytes, none of them sent
        socket.write(Buffer.from([0, 0, 16, 0, 0, 0, 0, 0, 1]));
      });
      setTimeout(() => socket.destroy(), 10);
    });
    socket.on("error", () => {});
    socket.on("close", () => resolve());
  });
}

await new Promise<void>((resolve) => {
  server.listen(0, "127.0.0.1", () => {
    const port = (server.address() as AddressInfo).port;
    void (async () => {
      await abortivePeer(port);
      await abortivePeer(port);
      const client = http2.connect(`http://127.0.0.1:${port}`);
      const request = client.request({ ":path": "/" });
      request.resume();
      request.on("end", () => {
        lines.push("served after the disconnects");
        client.close(() => server.close(() => resolve()));
      });
      request.end();
    })();
  });
});

for (const line of lines.sort()) console.log(line);
