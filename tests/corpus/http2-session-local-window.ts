// session.setLocalWindowSize(windowSize): Node validates the number (an
// integer in [0, 2^31-1]) and applies no observable change in Node 24 — no
// SETTINGS frame is submitted, the local settings record and the peer's view
// stay as they were. The thrown range errors carry Node's exact messages.
import * as http2 from "node:http2";
import type { AddressInfo } from "node:net";

const lines: string[] = [];
const server = http2.createServer();
server.on("session", (session) => {
  lines.push(`before ${session.pendingSettingsAck} ${session.localSettings.initialWindowSize}`);
  session.setLocalWindowSize(2 ** 20);
  lines.push(`after ${session.pendingSettingsAck} ${session.localSettings.initialWindowSize}`);
  session.on("localSettings", (settings) =>
    lines.push(`localSettings ${settings.initialWindowSize} ${session.pendingSettingsAck}`),
  );
  for (const value of [-5, 1.5, NaN, 2 ** 32, 2 ** 31 - 1]) {
    try {
      session.setLocalWindowSize(value);
      lines.push(`accepted ${value}`);
    } catch (error) {
      const failure = error as NodeJS.ErrnoException;
      lines.push(`${failure.code} ${failure.message}`);
    }
  }
  lines.push(`end ${session.localSettings.initialWindowSize}`);
});
server.on("stream", (stream) => {
  stream.respond({ ":status": 200 });
  stream.end("ok");
});
server.listen(0, "127.0.0.1", () => {
  const client = http2.connect(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  client.on("remoteSettings", (settings) => lines.push(`remoteSettings ${settings.initialWindowSize}`));
  const request = client.request({ ":path": "/" });
  request.on("error", () => {});
  request.resume();
  request.on("end", () => {
    client.destroy();
    server.close(() => {
      for (const line of lines) console.log(line);
    });
  });
  request.end();
});
