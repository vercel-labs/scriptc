// @exit: 1
// A RAW HTTP/2 stream (no request handler, no 'error' listener) has no
// internal listener in Node: a peer reset makes the stream emit 'error' and
// nothing catches it, so the process dies. This program's unhandled-'error'
// path is the same outcome; stderr's format is the documented divergence.
import * as http2 from "node:http2";
import * as net from "node:net";

const server = http2.createServer();
server.on("stream", (stream: http2.ServerHttp2Stream) => {
  console.log("stream", stream.id);
});

// a request block without END_STREAM, then RST_STREAM(PROTOCOL_ERROR)
const PEER_RST = Buffer.from([
  80, 82, 73, 32, 42, 32, 72, 84, 84, 80, 47, 50, 46, 48, 13, 10, 13, 10, 83, 77, 13, 10, 13, 10,
  0, 0, 0, 4, 0, 0, 0, 0, 0, 0, 0, 50, 1, 4, 0, 0, 0, 1, 0, 7, 58, 109, 101, 116,
  104, 111, 100, 3, 71, 69, 84, 0, 7, 58, 115, 99, 104, 101, 109, 101, 4, 104, 116, 116, 112, 0, 5, 58,
  112, 97, 116, 104, 1, 47, 0, 10, 58, 97, 117, 116, 104, 111, 114, 105, 116, 121, 1, 120, 0, 0, 4, 3,
  0, 0, 0, 0, 1, 0, 0, 0, 1,
]);

server.listen(0, "127.0.0.1", () => {
  const peer = net.connect((server.address() as net.AddressInfo).port, "127.0.0.1", () => {
    peer.write(PEER_RST);
  });
  peer.on("error", () => {});
});
