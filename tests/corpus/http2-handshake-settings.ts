// performServerHandshake's options carry the session's settings: a
// maxConcurrentStreams there is advertised in the session's first SETTINGS
// frame, so the peer's remoteSettings see it, while the session's own
// localSettings keep the previous record until the peer ACKs the frame. The
// default maxSessionMemory (10 MB) hands back a session.
import * as http2 from "node:http2";
import * as tls from "node:tls";
import * as fs from "node:fs";
import type { AddressInfo } from "node:net";

const key = fs.readFileSync("tests/fixtures/server/certs/localhost-key.pem");
const cert = fs.readFileSync("tests/fixtures/server/certs/localhost.pem");
const lines: string[] = [];
let acked = false;
let ended = false;
let client: http2.ClientHttp2Session | null = null;
let server: tls.Server | null = null;
const finish = (): void => {
  if (!acked || !ended || client === null || server === null) return;
  client.destroy();
  server.close(() => {
    for (const line of lines.sort()) console.log(line);
  });
};

server = tls.createServer({ key, cert, ALPNProtocols: ["h2"] }, (socket) => {
  const session = http2.performServerHandshake(socket, {
    maxSessionMemory: 10,
    settings: { maxConcurrentStreams: 1 },
  });
  lines.push(
    `handshake pending ${String(session.pendingSettingsAck)} mcs ${String(session.localSettings.maxConcurrentStreams)}`,
  );
  session.on("localSettings", (settings) => {
    lines.push(`localSettings mcs ${String(settings.maxConcurrentStreams)}`);
    lines.push(
      `acked pending ${String(session.pendingSettingsAck)} mcs ${String(session.localSettings.maxConcurrentStreams)}`,
    );
    acked = true;
    finish();
  });
  session.on("stream", (stream, headers) => {
    lines.push(`server stream ${String(headers[":path"])}`);
    stream.respond({ ":status": 200 });
    stream.end("ok");
  });
  session.on("error", () => {});
});
server.listen(0, "127.0.0.1", () => {
  client = http2.connect(
    `https://127.0.0.1:${((server as tls.Server).address() as AddressInfo).port}`,
    { rejectUnauthorized: false },
  );
  client.on("error", () => {});
  client.on("remoteSettings", (settings) => {
    lines.push(`remote maxConcurrentStreams ${String(settings.maxConcurrentStreams)}`);
  });
  const request = client.request({ ":path": "/one" });
  request.on("error", () => {});
  request.resume();
  request.on("end", () => {
    ended = true;
    finish();
  });
});
