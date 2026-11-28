// session.localSettings and remoteSettings answer an EMPTY record while the
// session is connecting (Node's getters) and the real records once it is
// established; a destroyed session answers empty again.
import * as http2 from "node:http2";
import type { AddressInfo } from "node:net";

const lines: string[] = [];

await new Promise<void>((resolve) => {
  const server = http2.createServer();
  server.on("stream", (stream) => {
    stream.respond({ ":status": 200 });
    stream.end("ok");
  });
  server.listen(0, "127.0.0.1", () => {
    const client = http2.connect(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    lines.push(`local keys before ${Object.keys(client.localSettings).length}`);
    lines.push(`remote keys before ${Object.keys(client.remoteSettings).length}`);
    lines.push(`local enablePush before ${client.localSettings.enablePush === true}`);
    client.on("connect", () => {
      lines.push(`local keys after ${Object.keys(client.localSettings).length}`);
      lines.push(`local enablePush after ${client.localSettings.enablePush === true}`);
      lines.push(`local maxFrameSize after ${client.localSettings.maxFrameSize === 16384}`);
      client.destroy();
      lines.push(`local keys destroyed ${Object.keys(client.localSettings).length}`);
      setTimeout(() => {
        server.close(() => resolve());
      }, 20);
    });
  });
});

for (const line of lines.sort()) console.log(line);
