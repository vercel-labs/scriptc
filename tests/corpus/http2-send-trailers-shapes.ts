// sendTrailers' refusals, Node's codes and precedence: before the
// 'wantTrailers' event ERR_HTTP2_TRAILERS_NOT_READY, after the first block
// ERR_HTTP2_TRAILERS_ALREADY_SENT (checked before the stream's closed
// state), and a pseudo-header in a trailer block is
// ERR_HTTP2_INVALID_PSEUDOHEADER.
import * as http2 from "node:http2";
import type { AddressInfo } from "node:net";

const lines: string[] = [];
const server = http2.createServer();
server.on("stream", (stream) => {
  const attempt = (label: string, fn: () => void) => {
    try {
      fn();
      lines.push(`${label} ok`);
    } catch (error) {
      const e = error as Error & { code?: string };
      lines.push(`${label} ${e.code ?? "-"} ${e.message}`);
    }
  };
  attempt("no-wait", () => stream.sendTrailers({ "x-a": "1" }));
  stream.respond({ ":status": 200 }, { waitForTrailers: true });
  attempt("before-want", () => stream.sendTrailers({ "x-b": "2" }));
  stream.on("wantTrailers", () => {
    attempt("pseudo", () => stream.sendTrailers({ ":path": "/x" }));
    attempt("in-want", () => stream.sendTrailers({ "x-c": "3" }));
    attempt("second", () => stream.sendTrailers({ "x-d": "4" }));
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
