// performServerHandshake's session emits 'connect' (session, socket) after
// the call returns — a listener attached next observes it — before the first
// stream. The options literal is evaluated (its call runs) even though the
// options are inert in this unit.
import * as http2 from "node:http2";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";

const lines: string[] = [];
function authorize() {
  lines.push("authorize");
  return {};
}

const server = createServer((socket) => {
  lines.push("connection");
  const session = http2.performServerHandshake(socket, { settings: authorize() });
  lines.push(`type ${session.type}`);
  session.on("connect", (connected, peer) =>
    lines.push(`connect ${connected === session} ${peer !== undefined}`),
  );
  session.on("stream", (stream, headers) => {
    lines.push(`stream ${String(headers[":path"])}`);
    stream.respond({ ":status": 200 });
    stream.end("ok");
  });
});
server.listen(0, "127.0.0.1", () => {
  const client = http2.connect(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  const request = client.request({ ":path": "/hs" });
  request.on("response", (headers) => lines.push(`response ${headers[":status"]}`));
  request.on("data", (chunk) => lines.push(`data ${String(chunk)}`));
  request.on("end", () =>
    client.close(() =>
      server.close(() => {
        for (const line of lines) console.log(line);
      }),
    ),
  );
  request.resume();
  request.end();
});
