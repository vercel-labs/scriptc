// Session and stream idle deadlines on node:http2. A session's setTimeout
// fires its 'timeout' listeners (the callback it registered first, then a
// listener added later) once the connection has been idle that long;
// setTimeout(0) clears the deadline so the follow-up stream does not
// re-arm it. The stream's own setTimeout fires on that stream alone, and
// clearing it keeps the stream's later close clean. The two ends run
// concurrently, so every line is printed sorted.
import * as http2 from "node:http2";

const lines: string[] = [];
const server = http2.createServer();
server.on("stream", (stream) => {
  // Hold the request open: the client stream stays idle on purpose.
  lines.push("server stream");
  stream.on("close", () => lines.push(`server stream close ${stream.rstCode}`));
});

await new Promise<void>((resolve) => {
  server.listen(0, "127.0.0.1", () => {
    const client = http2.connect(`http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`);
    client.on("connect", () => {
      client.setTimeout(40, () => lines.push("session callback"));
      client.on("timeout", () => {
        lines.push("session event");
        // Clearing the deadline: the stream below must not re-arm it.
        client.setTimeout(0);
        const request = client.request({ ":path": "/idle" });
        request.setTimeout(30, () => lines.push("stream callback"));
        request.on("timeout", () => {
          lines.push("stream event");
          request.setTimeout(0);
          request.close(http2.constants.NGHTTP2_CANCEL);
        });
        request.on("close", () => {
          client.close(() =>
            server.close(() => {
              for (const line of lines.sort()) console.log(line);
              resolve();
            }),
          );
        });
        request.resume();
        request.end();
      });
    });
  });
});
