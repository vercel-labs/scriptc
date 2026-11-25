// A typed connect listener on an HTTP/2 server declares its head as
// `Buffer | undefined`: the h2 arm has none, and the adapter builds that
// arm of the union, so the listener narrows without an uninitialized slot.
import * as http from "node:http";
import * as http2 from "node:http2";
import * as net from "node:net";

const h2 = http2.createServer((req: http2.Http2ServerRequest, res: http2.Http2ServerResponse) => {
  console.log("h2 request", req.method);
  res.end("ok");
});
h2.on(
  "connect",
  (
    req: http2.Http2ServerRequest,
    resOrSocket: http2.Http2ServerResponse | net.Socket,
    head: Buffer | undefined,
  ) => {
    console.log("h2 connect", req.method, head === undefined);
    if (resOrSocket instanceof net.Socket) {
      resOrSocket.destroy();
      return;
    }
    resOrSocket.writeHead(200, { "x-c": "1" });
    resOrSocket.end("tunneled");
  },
);
h2.listen(0, "127.0.0.1", () => {
  const port = (h2.address() as net.AddressInfo).port;
  const client = http2.connect("http://127.0.0.1:" + port);
  const tunnel = client.request({ ":method": "CONNECT", ":authority": "example.com:443" });
  tunnel.on("response", (h) => console.log("h2 tunnel", h[":status"], JSON.stringify(h["x-c"] ?? null)));
  let body = "";
  tunnel.on("data", (chunk: Uint8Array) => (body += Buffer.from(chunk).toString("utf8")));
  tunnel.on("end", () => {
    console.log("h2 body", JSON.stringify(body));
    client.close();
    h2.close();
  });
  tunnel.end();
});
