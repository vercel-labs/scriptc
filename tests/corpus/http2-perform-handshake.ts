// node:http2 performServerHandshake: a server session taken over an
// existing net socket (the peer speaks the h2 preface), with its own
// 'stream' listeners answering requests.
import * as http2 from "node:http2";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";

const lines: string[] = [];
function authorize() {
  lines.push("authorize");
  return {};
}
const server = createServer((socket) => {
  const session = http2.performServerHandshake(socket, { settings: authorize() });
  lines.push(`session type ${session.type}`);
  session.on("connect", (connected, peer) =>
    lines.push(`connect ${connected === session} ${peer !== undefined}`),
  );
  session.on("stream", (stream, headers) => {
    lines.push(`stream ${headers[":path"]}`);
    stream.respond({ ":status": 200, "x-s": "1" });
    stream.end("handled");
  });
  session.on("close", () => lines.push("session close"));
});
server.listen(0, "127.0.0.1", () => {
  const client = http2.connect(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  const request = client.request({ ":path": "/hs" });
  request.on("response", (headers: http2.IncomingHttpHeaders) =>
    lines.push(`response ${headers[":status"]} ${headers["x-s"]}`),
  );
  request.on("data", (chunk: Buffer) => lines.push(`data ${String(chunk)}`));
  request.on("end", () =>
    client.close(() =>
      server.close(() => {
        for (const line of lines.sort()) console.log(line);
      }),
    ),
  );
  request.resume();
  request.end();
});
