// The compatibility request's h2 state reads: :authority and :scheme, the
// backing stream (a bare read, the stream's id and pending flag), and the
// stream's endAfterHeaders and bufferSize. A body-less GET ends at its
// HEADERS block; a request that sends a body does not. The two ends race,
// so the recorded lines are sorted.
import * as http2 from "node:http2";
import type { AddressInfo } from "node:net";

const lines: string[] = [];

function run(path: string, withBody: boolean): Promise<void> {
  return new Promise<void>((resolve) => {
    const server = http2.createServer((request, response) => {
      const port = (server.address() as AddressInfo).port;
      lines.push(`${path} authority ${request.authority === `127.0.0.1:${port}`}`);
      lines.push(`${path} scheme ${request.scheme}`);
      lines.push(`${path} stream ${request.stream.id} ${request.stream.pending}`);
      lines.push(`${path} endAfterHeaders ${request.stream.endAfterHeaders}`);
      lines.push(`${path} bufferSize ${request.stream.bufferSize}`);
      request.resume();
      request.on("end", () => response.end("ok"));
    });
    server.listen(0, "127.0.0.1", () => {
      const client = http2.connect(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
      client.on("connect", () => {
        const request = withBody
          ? client.request({ ":path": path }, { endStream: false })
          : client.request({ ":path": path });
        request.on("response", (headers) => lines.push(`${path} response ${headers[":status"]}`));
        request.resume();
        request.on("end", () => {
          client.close(() => server.close(() => resolve()));
        });
        request.end();
      });
    });
  });
}

await run("/get", false);
await run("/post", true);

for (const line of lines.sort()) console.log(line);
