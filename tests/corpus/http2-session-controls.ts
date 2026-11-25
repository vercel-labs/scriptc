// Http2Session controls: session.setTimeout() arms the socket's idle timer
// and its callback is a once 'timeout' listener (the event fires too);
// session.goaway([code][, lastStreamID][, opaqueData]) sends the frames,
// with the lastStreamID defaulting to the last processed stream; ref/unref
// are the underlying socket's loop reference (Node answers undefined).
import * as http2 from "node:http2";
import type { AddressInfo } from "node:net";

const lines: string[] = [];

function run(
  label: string,
  sendGoaway: (session: http2.ServerHttp2Session) => void,
  withTimeout: boolean,
): Promise<void> {
  return new Promise((resolve) => {
    const server = http2.createServer();
    let session: http2.ServerHttp2Session | undefined;
    server.on("session", (opened) => {
      session = opened;
      lines.push(`${label} session`);
      if (!withTimeout) return;
      session.on("timeout", () => lines.push(`${label} timeout event`));
      session.setTimeout(20, () => lines.push(`${label} timeout cb`));
      // the underlying socket's loop reference (Node answers undefined)
      session.ref();
      session.unref();
    });
    server.on("stream", (stream, headers) => {
      lines.push(`${label} stream ${String(headers[":path"])}`);
      if (session !== undefined) sendGoaway(session);
      stream.respond({ ":status": 200 });
      stream.end("ok");
    });
    server.listen(0, "127.0.0.1", () => {
      const client = http2.connect(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
      client.on(
        "goaway",
        (code: number, lastStreamID: number, opaque: Uint8Array | undefined) => {
          lines.push(
            `${label} goaway ${code} ${lastStreamID} ${
              opaque === undefined ? "none" : Buffer.from(opaque).toString("utf8")
            }`,
          );
        },
      );
      client.on("error", (error) => {
        lines.push(`${label} client error ${String((error as NodeJS.ErrnoException).code)}`);
      });
      const send = () => {
        const request = client.request({ ":path": "/" });
        request.on("response", (responseHeaders) => {
          lines.push(`${label} response ${responseHeaders[":status"]}`);
        });
        request.on("data", (chunk) => lines.push(`${label} data ${String(chunk)}`));
        request.on("error", (error) => {
          lines.push(`${label} request error ${String((error as NodeJS.ErrnoException).code)}`);
        });
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          client.destroy();
          server.close(() => resolve());
        };
        request.on("end", finish);
        request.on("close", finish);
        request.resume();
        request.end();
      };
      if (withTimeout) setTimeout(send, 60);
      else send();
    });
  });
}

await run("timed", (session) => session.goaway(), true);
await run("opaque", (session) => session.goaway(0, 1, Buffer.from("bye")), false);

for (const line of lines) console.log(line);
