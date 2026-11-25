// node:http2 settings: getDefaultSettings(), a session's localSettings and
// remoteSettings records, the 'localSettings' and 'remoteSettings' events
// with their settings argument, settings() with its (err, settings,
// duration) callback, and pendingSettingsAck. A session's own record
// changes when the peer acknowledges the frame, not when settings() is
// called. A session that has not exchanged a header list limit reports
// 4294967295 for it, where getDefaultSettings() names 65535. A client's
// enablePush is left out: scriptc clients refuse pushed streams and say so
// in their settings, Node's leave push enabled. The two ends race, so the
// lines are sorted.
import http2 from "node:http2";

console.log(JSON.stringify(http2.getDefaultSettings()));

const pick = (s) => `${Object.keys(s).join(",")} window=${s.initialWindowSize} frame=${s.maxFrameSize} list=${s.maxHeaderListSize} size=${s.maxHeaderSize} table=${s.headerTableSize} streams=${s.maxConcurrentStreams} connect=${s.enableConnectProtocol}`;

await new Promise((resolve) => {
  const lines = [];
  const server = http2.createServer();
  server.on("session", (session) => {
    let remote = 0;
    session.on("remoteSettings", (settings) => lines.push(`server remoteSettings ${++remote} ${pick(settings)}`));
    session.on("localSettings", (settings) => lines.push(`server localSettings ${pick(settings)} push=${settings.enablePush}`));
  });
  server.listen(0, "127.0.0.1", () => {
    const client = http2.connect(`http://127.0.0.1:${server.address().port}`);
    let local = 0;
    client.on("remoteSettings", (settings) => {
      lines.push(`client remoteSettings ${pick(settings)} push=${settings.enablePush}`);
      lines.push(`client remoteSettings read ${pick(client.remoteSettings)} push=${client.remoteSettings.enablePush}`);
    });
    client.on("localSettings", (settings) => {
      lines.push(`client localSettings ${++local} ${pick(settings)} pending=${client.pendingSettingsAck}`);
      if (local === 2) {
        lines.push(`client localSettings read ${pick(client.localSettings)}`);
        client.close(() =>
          server.close(() => {
            for (const line of lines.sort()) console.log(line);
            resolve(undefined);
          }),
        );
      }
    });
    client.on("connect", () => {
      lines.push(`client before ${pick(client.localSettings)} pending=${client.pendingSettingsAck}`);
      client.settings({ initialWindowSize: 100000, maxFrameSize: 32768 }, (error, settings, duration) => {
        lines.push(`client ack ${error} ${pick(settings)} ${typeof duration}`);
      });
      lines.push(`client after settings() ${pick(client.localSettings)} pending=${client.pendingSettingsAck}`);
    });
  });
});
