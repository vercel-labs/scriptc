// The compatibility request takes url from the frame's :path, so a CONNECT
// block — which carries none — reads Node's undefined, while an ordinary
// request still reads its path. The client sends a CONNECT exactly as Node
// does: :method and :authority, no :scheme and no :path.
import * as http2 from "node:http2";
import * as net from "node:net";

const h2 = http2.createServer((req: http2.Http2ServerRequest, res: http2.Http2ServerResponse) => {
  console.log("request", req.method, JSON.stringify(req.url));
  res.end("ok");
});
h2.on(
  "connect",
  (
    req: http2.Http2ServerRequest,
    resOrSocket: http2.Http2ServerResponse | net.Socket,
    head: Buffer | undefined,
  ) => {
    console.log(
      "connect",
      req.method,
      JSON.stringify(req.url ?? "(undefined)"),
      JSON.stringify(req.headers[":path"] ?? "(none)"),
      head === undefined,
    );
    if (resOrSocket instanceof net.Socket) {
      resOrSocket.destroy();
      return;
    }
    resOrSocket.writeHead(200);
    resOrSocket.end();
  },
);
h2.listen(0, "127.0.0.1", () => {
  const port = (h2.address() as net.AddressInfo).port;
  const client = http2.connect("http://127.0.0.1:" + port);
  client.on("error", () => {});
  const get = client.request({ ":path": "/hello" });
  get.resume();
  get.on("end", () => {
    const tunnel = client.request({ ":method": "CONNECT", ":authority": "example.com:443" });
    tunnel.on("response", (h) => console.log("tunnel", h[":status"]));
    tunnel.resume();
    tunnel.on("end", () => {
      client.close();
      h2.close();
    });
    tunnel.end();
  });
  get.end();
});
