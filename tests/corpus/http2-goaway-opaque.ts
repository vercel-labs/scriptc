// The three-parameter 'goaway' listener sees the frame's opaque data: a
// Buffer when the sender appended any, undefined when it did not (Node's
// shape, so the parameter is Buffer | undefined).
import * as http2 from "node:http2";
import type { AddressInfo } from "node:net";

const lines: string[] = [];

async function run(label: string, withData: boolean): Promise<void> {
  const server = http2.createServer();
  server.on("stream", (stream) => {
    stream.respond({ ":status": 200 });
    stream.end("ok");
  });
  server.on("session", (session) => {
    setTimeout(() => {
      if (withData) session.goaway(0, 1, Buffer.from("hi"));
      else session.goaway(0, 1);
    }, 30);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => {
    const client = http2.connect(`http://127.0.0.1:${port}`);
    client.on(
      "goaway",
      (code: number, last: number, opaque: Uint8Array | undefined) => {
        lines.push(
          `${label} code=${code} last=${last} undefined=${opaque === undefined} ` +
            `buffer=${Buffer.isBuffer(opaque)} length=${opaque === undefined ? -1 : opaque.length}`,
        );
      },
    );
    client.on("error", () => {});
    const request = client.request({ ":path": "/" });
    request.on("error", () => {});
    request.resume();
    setTimeout(() => {
      client.destroy();
      server.close(() => resolve());
    }, 300);
  });
}

await run("no-data", false);
await run("with-data", true);
for (const line of lines.sort()) console.log(line);
