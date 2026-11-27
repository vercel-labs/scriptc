// performServerHandshake's options carry the session's settings: a
// maxConcurrentStreams there is advertised in the session's first SETTINGS
// frame, so the peer's remoteSettings see it.
import * as http2 from "node:http2";
import * as tls from "node:tls";
import * as fs from "node:fs";
import type { AddressInfo } from "node:net";

const key = fs.readFileSync("tests/fixtures/server/certs/localhost-key.pem");
const cert = fs.readFileSync("tests/fixtures/server/certs/localhost.pem");
const lines: string[] = [];

const server = tls.createServer({ key, cert, ALPNProtocols: ["h2"] }, (socket) => {
  const session = http2.performServerHandshake(socket, {
    settings: { maxConcurrentStreams: 1 },
  });
  session.on("stream", (stream, headers) => {
    lines.push(`server stream ${String(headers[":path"])}`);
    stream.respond({ ":status": 200 });
    stream.end("ok");
  });
  session.on("error", () => {});
});
server.listen(0, "127.0.0.1", () => {
  const client = http2.connect(`https://127.0.0.1:${(server.address() as AddressInfo).port}`, {
    rejectUnauthorized: false,
  });
  client.on("error", () => {});
  client.on("remoteSettings", (settings) => {
    lines.push(`remote maxConcurrentStreams ${String(settings.maxConcurrentStreams)}`);
  });
  const request = client.request({ ":path": "/one" });
  request.on("error", () => {});
  request.resume();
  request.on("end", () => {
    client.destroy();
    server.close(() => {
      for (const line of lines.sort()) console.log(line);
    });
  });
});
