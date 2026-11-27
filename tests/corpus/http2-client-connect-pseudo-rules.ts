// Node's client validates a CONNECT request's pseudo-headers before any
// stream exists: :authority is required and :scheme / :path are forbidden
// (an extended CONNECT with :protocol keeps the regular pseudo set). Each
// violation throws Node's error, code and message.
import * as http2 from "node:http2";
import * as net from "node:net";

const server = http2.createServer((req: http2.Http2ServerRequest, res: http2.Http2ServerResponse) => {
  res.end("ok");
});
server.listen(0, "127.0.0.1", () => {
  const port = (server.address() as net.AddressInfo).port;
  const client = http2.connect("http://127.0.0.1:" + port);
  client.on("error", () => {});
  const attempt = (label: string, headers: http2.OutgoingHttpHeaders): void => {
    try {
      const stream = client.request(headers);
      stream.on("error", () => {});
      stream.end();
      console.log(label, "ok");
    } catch (error) {
      const e = error as { code?: string; message: string };
      console.log(label, e.code ?? "(no code)", e.message);
    }
  };
  attempt("path", { ":method": "CONNECT", ":authority": "a", ":path": "/" });
  attempt("scheme", { ":method": "CONNECT", ":authority": "a", ":scheme": "https" });
  attempt("authority", { ":method": "CONNECT" });
  setTimeout(() => {
    client.destroy();
    server.close();
  }, 100);
});
