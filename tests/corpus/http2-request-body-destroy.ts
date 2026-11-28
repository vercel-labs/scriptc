// A destroy() on an actively iterated HTTP/2 compatibility request: the
// message's iterator rejects with Node's ERR_STREAM_PREMATURE_CLOSE
// ("Premature close"), never a clean end of body.
import { createServer, connect } from "node:http2";
import type { ClientHttp2Session } from "node:http2";
import type { AddressInfo } from "node:net";

const watchdog = setTimeout(() => {
  console.log("pending");
  process.exit(2);
}, 500);

const lines: string[] = [];
let client: ClientHttp2Session | null = null;

const server = createServer((req, res) => {
  void (async () => {
    try {
      for await (const chunk of req) lines.push(`chunk ${(chunk as Buffer).toString()}`);
      lines.push("loop done");
    } catch (error) {
      const err = error as Error & { code?: string };
      lines.push(`caught ${String(err.code)} ${err.message}`);
    }
    try {
      res.end();
    } catch {
      // the request was destroyed
    }
    clearTimeout(watchdog);
    setTimeout(() => {
      client?.destroy();
      server.close(() => {
        for (const line of lines.sort()) console.log(line);
      });
    }, 60);
  })();
  setTimeout(() => req.destroy(), 30);
});

server.listen(0, "127.0.0.1", () => {
  client = connect(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  client.on("error", () => {});
  const stream = client.request({ ":method": "POST", ":path": "/" }, { endStream: false });
  stream.on("error", () => {});
  stream.write("a");
});
