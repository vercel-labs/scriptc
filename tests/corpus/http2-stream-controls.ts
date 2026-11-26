// @normalize-pid
// Http2Stream controls: stream.setTimeout() arms the stream's own idle timer
// (independent of the session socket's), with its callback registered as a
// once 'timeout' listener; 'ready' fires for a request created while the
// session is still connecting (a request on a connected session initializes
// inside request(), so its 'ready' precedes any listener, as in Node); and
// priority(options) — deprecated by RFC 9113 — is accepted and ignored.
import * as http2 from "node:http2";
import type { AddressInfo } from "node:net";

const lines: string[] = [];
const server = http2.createServer();
server.on("stream", (stream, headers) => {
  lines.push(`stream ${String(headers[":path"])}`);
  stream.priority({ weight: 10 });
  lines.push("priority ok");
  stream.on("timeout", () => lines.push("stream timeout event"));
  stream.setTimeout(30, () => lines.push("stream timeout cb"));
  setTimeout(() => {
    lines.push("timed respond");
    stream.respond({ ":status": 200 });
    stream.end("timed ok");
  }, 90);
});
server.listen(0, "127.0.0.1", () => {
  const client = http2.connect(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  client.on("connect", () => lines.push("session connect"));
  const request = client.request({ ":path": "/timed" });
  request.on("ready", () => lines.push(`ready id ${request.id}`));
  request.on("response", (responseHeaders) => {
    lines.push(`response ${responseHeaders[":status"]}`);
  });
  request.on("data", (chunk) => lines.push(`data ${String(chunk)}`));
  request.on("end", () => {
    client.destroy();
    server.close(() => {
      for (const line of lines) console.log(line);
    });
  });
  request.resume();
  request.end();
});
