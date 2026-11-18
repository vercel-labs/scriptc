// node:http2 stream errors carry Node's code: a stream closed with a
// nonzero RST_STREAM code emits 'error' with code ERR_HTTP2_STREAM_ERROR on
// both ends, its message naming the error code, before 'close'. The two
// ends race, so the recorded lines are sorted.
import * as http2 from "node:http2";
import type { AddressInfo } from "node:net";

const lines: string[] = [];
const server = http2.createServer();
server.on("stream", (stream) => {
  stream.on("error", (error) =>
    lines.push(
      `server error ${error.name} ${(error as NodeJS.ErrnoException).code} ${error.message}`,
    ),
  );
  stream.on("close", () => lines.push(`server close ${stream.rstCode}`));
  stream.resume();
});
server.listen(0, "127.0.0.1", () => {
  const client = http2.connect(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  const request = client.request({ ":path": "/", ":method": "POST" });
  request.on("error", (error) =>
    lines.push(
      `client error ${error.name} ${(error as NodeJS.ErrnoException).code} ${error.message}`,
    ),
  );
  request.on("close", () => {
    lines.push(`client close ${request.rstCode}`);
    client.close(() => {
      server.close(() => {
        for (const line of lines.sort()) console.log(line);
      });
    });
  });
  request.write("partial");
  setTimeout(() => request.close(http2.constants.NGHTTP2_PROTOCOL_ERROR), 50);
});
