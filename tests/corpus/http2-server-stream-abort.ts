// A server stream's request body torn down by the peer (no END_STREAM):
// Node rejects the reader with ERR_STREAM_PREMATURE_CLOSE instead of
// reporting a finished body.
import * as http2 from "node:http2";
import type { AddressInfo } from "node:net";

const lines: string[] = [];
let closed = false;
let settled = false;

const server = http2.createServer();
const finish = (): void => {
  if (!closed || !settled) return;
  server.close(() => {
    for (const line of lines.sort()) console.log(line);
  });
};

server.on("stream", (stream) => {
  stream.on("error", () => {});
  stream.on("aborted", () => lines.push("server aborted"));
  stream.on("close", () => {
    lines.push(`server close rst=${stream.rstCode}`);
    closed = true;
    finish();
  });
  void (async () => {
    try {
      for await (const chunk of stream) lines.push(`server chunk ${(chunk as Buffer).toString()}`);
      lines.push("server loop done");
    } catch (err) {
      lines.push(
        `server caught ${String((err as { code?: string }).code)} ${(err as Error).message}`,
      );
    }
    settled = true;
    finish();
  })();
});

server.listen(0, "127.0.0.1", () => {
  const client = http2.connect(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  client.on("error", () => {});
  const req = client.request({ ":path": "/" }, { endStream: false });
  req.on("error", () => {});
  req.write("a");
  setTimeout(() => client.destroy(), 50);
});
