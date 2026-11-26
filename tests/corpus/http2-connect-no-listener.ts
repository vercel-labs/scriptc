// A compatibility server without a 'connect' listener still owns the CONNECT
// stream: Node's compat layer creates the pair and answers 405 itself, so the
// 405 is delivered and a peer reset of that stream is an ordinary compat
// reset, not an unhandled raw-stream error.
import * as http2 from "node:http2";
import * as net from "node:net";

const server = http2.createServer((req: http2.Http2ServerRequest, res: http2.Http2ServerResponse) => {
  console.log("request", req.method, req.url);
  res.end("ok");
});

// a CONNECT block without END_STREAM, then RST_STREAM(PROTOCOL_ERROR)
const CONNECT_RST = Buffer.from([
  80, 82, 73, 32, 42, 32, 72, 84, 84, 80, 47, 50, 46, 48, 13, 10, 13, 10, 83, 77, 13, 10, 13, 10,
  0, 0, 0, 4, 0, 0, 0, 0, 0, 0, 0, 31, 1, 4, 0, 0, 0, 1, 0, 7, 58, 109, 101, 116,
  104, 111, 100, 7, 67, 79, 78, 78, 69, 67, 84, 0, 10, 58, 97, 117, 116, 104, 111, 114, 105, 116,
  121, 1, 120, 0, 0, 4, 3, 0, 0, 0, 0, 1, 0, 0, 0, 1,
]);

let port = 0;

const rawPhase = (): void => {
  const peer = net.connect(port, "127.0.0.1", () => peer.write(CONNECT_RST));
  peer.on("error", () => {});
  setTimeout(() => {
    console.log("survived");
    peer.destroy();
    server.close();
  }, 200);
};

server.listen(0, "127.0.0.1", () => {
  port = (server.address() as net.AddressInfo).port;
  const client = http2.connect("http://127.0.0.1:" + port);
  client.on("error", () => {});
  const req = client.request({ ":method": "CONNECT", ":authority": "example.com:443" });
  req.on("response", (headers) => {
    console.log("status", headers[":status"]);
    req.close();
    client.destroy();
    rawPhase();
  });
  req.on("error", () => {});
  req.resume();
  req.end();
});
